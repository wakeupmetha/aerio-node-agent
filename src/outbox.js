// Durable FIFO of geocheck snapshots awaiting an explicit core acknowledgement.
// Mutations are serialized and atomically replaced so an acknowledgement racing
// a new result cannot remove it. Never truncate undelivered items.
// ponytail: rewrites the full queue; use an append-only log if long outages make this costly.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export class GeocheckOutbox {
  constructor(file) {
    this.file = file;
    this.items = [];
    this.operation = Promise.resolve();
  }

  async init() {
    await mkdir(dirname(this.file), { recursive: true });
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      if (!Array.isArray(data) || data.some((item) => !item || typeof item.id !== 'string' || !item.digest)) {
        throw new Error('invalid outbox format');
      }
      this.items = data;
    } catch (e) {
      if (e?.code !== 'ENOENT') throw e;
    }
  }

  get size() { return this.items.length; }
  peek() { return this.items[0] ?? null; }

  async change(update) {
    const operation = this.operation.then(async () => {
      const next = update(this.items);
      if (next === this.items) return;
      const tmp = this.file + '.tmp';
      await writeFile(tmp, JSON.stringify(next));
      await rename(tmp, this.file);
      this.items = next;
    });
    this.operation = operation.catch(() => {});
    return operation;
  }

  enqueue(digest) {
    const item = { id: randomUUID(), digest };
    return this.change((items) => [...items, item]);
  }

  acknowledge(id) {
    return this.change((items) => items[0]?.id === id ? items.slice(1) : items);
  }
}
