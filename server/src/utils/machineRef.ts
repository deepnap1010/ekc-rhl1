// server/src/utils/machineRef.ts
// Machine codes come from the factory's own collections — ingest upserts the
// PLC's machineId verbatim — so nothing guarantees their case. Assignments,
// schedules and users' assignedMachines all store whatever they were given.
// These two helpers make every comparison case-insensitive without rewriting
// anyone's stored value.
const ESCAPE = /[.*+?^${}()|[\]\\]/g;

/** A query value matching one machine ref regardless of case. */
export const refMatch = (ref: string): RegExp => new RegExp(`^${ref.replace(ESCAPE, '\\$&')}$`, 'i');

/** Case-insensitive membership, for scope lists. */
export const refIn = (list: string[] | null | undefined, ref: string): boolean =>
  (list || []).some((r) => r.toUpperCase() === ref.toUpperCase());
