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

/** Case variants of a ref, for an $in that can still USE the index.
 *
 *  refMatch's regex is fine on the small collections, but on `telemetries` a
 *  case-insensitive regex cannot use {machineId, timestamp} and turns a 36k-doc
 *  read into a 900k-doc collection scan — measured 2656ms against 76ms. Machine
 *  codes are a closed set of known strings, so listing their variants keeps the
 *  tolerance and keeps the index. */
export const refCandidates = (ref: string): string[] => {
  const r = String(ref || '');
  return [...new Set([r, r.toUpperCase(), r.toLowerCase()])].filter(Boolean);
};
