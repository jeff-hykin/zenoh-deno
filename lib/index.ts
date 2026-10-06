//
// Copyright (c) 2023 ZettaScale Technology
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License 2.0 which is available at
// http://www.eclipse.org/legal/epl-2.0, or the Apache License, Version 2.0
// which is available at https://www.apache.org/licenses/LICENSE-2.0.
//
// SPDX-License-Identifier: EPL-2.0 OR Apache-2.0
//
// Contributors:
//   ZettaScale Zenoh Team, <zenoh@zettascale.tech>
//

// API Layer Files
export { KeyExpr, type IntoKeyExpr } from "./key_expr.ts";
export { ZBytes, type IntoZBytes } from "./z_bytes.ts";
export {
  CongestionControl,
  ConsolidationMode,
  Locality,
  Priority,
  QueryTarget,
  Reliability,
  SampleKind,
  ReplyKeyExpr,
  WhatAmI,
} from "./enums.ts";
export { Sample } from "./sample.ts";
export { Timestamp } from "./timestamp.ts";
export { ZenohId } from "./zid.ts";
export { Publisher, Subscriber, type PublisherPutOptions, type PublisherDeleteOptions } from "./pubsub.ts";
export {
  type IntoSelector,
  Parameters,
  type IntoParameters,
  Query,
  Queryable,
  Reply,
  ReplyError,
  type ReplyOptions,
  type ReplyErrOptions,
  type ReplyDelOptions,
  Selector,
} from "./query.ts";
export {
  Session,
  type DeleteOptions,
  type PutOptions,
  type GetOptions,
  type QueryableOptions,
  type QuerierOptions,
  type PublisherOptions,
  SessionInfo,
  type SubscriberOptions,
  open
} from "./session.ts";
export { Config } from "./config.ts";
export { Encoding, type IntoEncoding } from "./encoding.ts";
export { Liveliness, LivelinessToken } from "./liveliness.ts";
export { Querier, type QuerierGetOptions } from "./querier.ts";
export {
  FifoChannel,
  RingChannel,
  type ChannelReceiver,
  type ChannelSender,
  type TryReceived,
  TryReceivedKind,
  ChannelState,
} from "./channels.ts";
export {
  MatchingListener,
  type MatchingListenerOptions,
  MatchingStatus,
} from "./matching.ts";
export {
  TransportInfo,
  LinkInfo,
  TransportEvent,
  LinkEvent,
  TransportEventsListener,
  LinkEventsListener,
  type TransportEventsListenerOptions,
  type LinkEventsListenerOptions,
} from "./connectivity.ts";
export { CancellationToken } from "./cancellation_token.ts"
// Re-export duration external library
export { Duration } from "./duration.ts";
export type { TimeDuration, MaybeTimeDuration } from "./duration.ts";

// zenoh-deno additions: in-process sessions, shared memory, zero-copy payloads
export type { OpenOptions } from "./session.ts";
export { ShmProvider, ZShmMut, AllocPolicy } from "./shm.ts";
export type { ShmProviderOptions } from "./shm.ts";
export { ZENOH_VERSIONS, DEFAULT_ZENOH_VERSION } from "./native/library.ts";
export { initLog, setZeroCopyThreshold, nativePayloadsAlive } from "./native/settings.ts";
