import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GeocheckOutbox } from '../src/outbox.js';
import { createPanelClient } from '../src/panel.js';

const log = Object.fromEntries(['debug', 'info', 'warn', 'error'].map((k) => [k, () => {}]));
const digest = (ranAt, state) => ({ ranAt, services: [{ id: 'netflix', name: 'Netflix', state }] });

async function withOutbox(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-outbox-'));
  try {
    const file = join(dir, 'outbox.json');
    const outbox = new GeocheckOutbox(file);
    await outbox.init();
    await fn(outbox, file);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('pending snapshots survive restart and acknowledgement races with enqueue', async () => {
  await withOutbox(async (queue, file) => {
    await queue.enqueue(digest('1', 'available'));
    const id = queue.peek().id;
    await Promise.all([queue.enqueue(digest('2', 'blocked')), queue.acknowledge(id)]);
    const restored = new GeocheckOutbox(file);
    await restored.init();
    assert.equal(restored.size, 1);
    assert.equal(restored.peek().digest.ranAt, '2');
    await restored.acknowledge('not-the-head');
    assert.equal(restored.size, 1);
  });
});

test('lost responses retry the same snapshot and drain following snapshots in order', async () => {
  await withOutbox(async (queue, file) => {
    await queue.enqueue(digest('1', 'blocked'));
    await queue.enqueue(digest('2', 'available'));
    const sent = [];
    let failure = true;
    const fetchImpl = async (_url, init) => {
      const body = JSON.parse(init.body);
      sent.push(body.delivery);
      if (failure) { failure = false; throw new Error('response lost'); }
      return new Response(JSON.stringify({ ok: true, node: 'node', commands: [], deliveryAck: body.delivery.id }));
    };
    const client = createPanelClient({ url: 'http://core.local', token: 'token', log,
      state: () => ({ agent: { heartbeatMs: 30000 }, geocheck: digest('2', 'available'), delivery: queue.peek() }),
      onCommand: () => {}, onDeliveryAck: (id) => queue.acknowledge(id), pendingDeliveries: () => queue.size,
      retryBaseMs: 10, fetchImpl });
    await client.beat();
    assert.equal(queue.size, 2);
    const restored = new GeocheckOutbox(file);
    await restored.init();
    assert.equal(restored.peek().id, sent[0].id);
    for (let i = 0; i < 100 && queue.size; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(queue.size, 0);
    assert.equal(sent[0].id, sent[1].id);
    assert.notEqual(sent[1].id, sent[2].id);
    assert.deepEqual(sent.map((x) => x.digest.ranAt), ['1', '1', '2']);
    client.stop();
  });
});

test('an older receiver without acknowledgement never deletes the durable queue', async () => {
  await withOutbox(async (queue) => {
    await queue.enqueue(digest('1', 'blocked'));
    const client = createPanelClient({ url: 'http://core.local', token: 'token', log,
      state: () => ({ agent: { heartbeatMs: 30000 }, delivery: queue.peek() }),
      onCommand: () => {}, onDeliveryAck: (id) => queue.acknowledge(id), pendingDeliveries: () => queue.size,
      fetchImpl: async () => new Response(JSON.stringify({ ok: true, node: 'node', commands: [] })) });
    await client.beat();
    assert.equal(queue.size, 1);
    client.stop();
  });
});


test('corrupted on-disk queue is reported and never overwritten', async () => {
  await withOutbox(async (_queue, file) => {
    await writeFile(file, '{broken');
    const restored = new GeocheckOutbox(file);
    await assert.rejects(restored.init());
    assert.equal(await readFile(file, 'utf8'), '{broken');
  });
});
