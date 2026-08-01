import { EventEmitter } from 'node:events';
import type { DmlOperation } from '../dml/hooks.js';

export interface ChangeEvent {
  orgId: string;
  object: string;
  operation: DmlOperation;
  recordIds: string[];
  /** The saved records, so a subscriber can filter without a round trip. */
  records: Array<Record<string, any>>;
  at: string;
}

/**
 * In-process change bus.
 *
 * Events are published after commit, never inside the transaction: a subscriber must not be told
 * about a record that a rollback is about to remove. The SSE endpoint and PushTopic matching will
 * subscribe here; across replicas this becomes LISTEN/NOTIFY without the publishers changing.
 */
class ChangeBus extends EventEmitter {
  publish(event: ChangeEvent): void {
    this.emit('change', event);
    this.emit(`change:${event.orgId}:${event.object}`, event);
  }

  subscribe(listener: (event: ChangeEvent) => void): () => void {
    this.on('change', listener);
    return () => this.off('change', listener);
  }

  subscribeTo(orgId: string, object: string, listener: (event: ChangeEvent) => void): () => void {
    const key = `change:${orgId}:${object}`;
    this.on(key, listener);
    return () => this.off(key, listener);
  }
}

export const changeBus = new ChangeBus();
// Streaming clients can be numerous; the default limit of 10 is far too low.
changeBus.setMaxListeners(0);
