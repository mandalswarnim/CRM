import type { Grain } from './span.js';

export type ResourceMode = 'exclusive' | 'pool';
export type AllocationStatus = 'Reserved' | 'Held' | 'Released';

/** One opening window on a resource: `{ day: 2, from: '18:00', to: '21:30' }`. */
export interface BookingWindow {
  /** 0 = Sunday, matching `Date.getUTCDay()`. */
  day: number;
  from: string;
  to: string;
}

export interface Resource {
  id: string;
  apiName: string;
  label: string;
  kind: string;
  mode: ResourceMode;
  capacity: number;
  overbook: number;
  grain: Grain;
  ordinal: bigint;
  windows: BookingWindow[] | null;
  active: boolean;
  attributes: Record<string, unknown>;
}

export interface ResourceInput {
  apiName: string;
  label?: string;
  kind?: string;
  mode?: ResourceMode;
  capacity?: number;
  overbook?: number;
  grain?: Grain;
  windows?: BookingWindow[] | null;
  active?: boolean;
  attributes?: Record<string, unknown>;
}

export interface Allocation {
  id: string;
  resourceId: string;
  objectApi: string;
  recordId: string;
  quantity: number;
  startsAt: string;
  endsAt: string;
  status: AllocationStatus;
  expiresAt: string | null;
}

export interface ReserveRequest {
  resource: string;
  objectApi: string;
  recordId: string;
  startsAt: Date;
  endsAt: Date;
  quantity?: number;
  /** A hold blocks like a reservation but lapses; minutes from now. */
  holdMinutes?: number;
}

/**
 * How an object's records drive allocation, stored on `object_def.booking`.
 *
 * This is what keeps the club out of the engine: `Booking__c` is an ordinary metadata object, and
 * this record says which of its fields mean "what", "from" and "until".
 */
export interface BookingConfig {
  /** Field holding the resource api_name or a lookup to a resource-bearing record. */
  resourceField: string;
  startField: string;
  endField: string;
  /** Optional: covers, or number of rooms. Defaults to 1. */
  quantityField?: string;
  /** Optional: when this field holds one of `cancelledValues`, the allocation is released. */
  statusField?: string;
  cancelledValues?: string[];
  /** Treat saves as holds rather than firm reservations, lapsing after this many minutes. */
  holdMinutes?: number;
}

export interface AvailabilityRequest {
  resource: string;
  from: Date;
  to: Date;
  quantity?: number;
}

export interface AvailabilitySlot {
  /** Start of the grain step, ISO. */
  at: string;
  capacity: number;
  taken: number;
  remaining: number;
}

export interface AvailabilityResult {
  resource: string;
  mode: ResourceMode;
  grain: Grain;
  available: boolean;
  slots: AvailabilitySlot[];
}
