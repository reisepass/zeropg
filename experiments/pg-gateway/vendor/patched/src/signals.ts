// @ts-nocheck - vendored pg-gateway source (targets DOM/Deno libs); typechecked upstream, not here
export const tlsUpgradeSignal = Symbol('tls-upgrade');
export const closeSignal = Symbol('close');

export type TlsUpgradeSignal = typeof tlsUpgradeSignal;
export type CloseSignal = typeof closeSignal;

export type ConnectionSignal = TlsUpgradeSignal | CloseSignal;
