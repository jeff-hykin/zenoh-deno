// Every name @eclipse-zenoh/zenoh-ts 1.10.1 exports is exported here too (generated from its index.ts and ext/index.ts).
// Values are checked at runtime; types by type-checking this file.

import { assert } from "jsr:@std/assert@1"
import * as zenoh from "../mod.ts"
import * as ext from "../ext.ts"
import type { IntoKeyExpr, IntoZBytes, PublisherPutOptions, PublisherDeleteOptions, IntoSelector, IntoParameters, ReplyOptions, ReplyErrOptions, ReplyDelOptions, DeleteOptions, PutOptions, GetOptions, QueryableOptions, QuerierOptions, PublisherOptions, SubscriberOptions, IntoEncoding, QuerierGetOptions, ChannelReceiver, ChannelSender, TryReceived, MatchingListenerOptions, TransportEventsListenerOptions, LinkEventsListenerOptions } from "../mod.ts"
import type { ZSerializeable, ZDeserializeable } from "../ext.ts"

const UPSTREAM_VALUES = ["KeyExpr","ZBytes","CongestionControl","ConsolidationMode","Locality","Priority","QueryTarget","Reliability","SampleKind","ReplyKeyExpr","WhatAmI","Sample","Timestamp","ZenohId","Publisher","Subscriber","Parameters","Query","Queryable","Reply","ReplyError","Selector","Session","SessionInfo","open","Config","Encoding","Liveliness","LivelinessToken","Querier","FifoChannel","RingChannel","TryReceivedKind","ChannelState","MatchingListener","MatchingStatus","TransportInfo","LinkInfo","TransportEvent","LinkEvent","TransportEventsListener","LinkEventsListener","CancellationToken","Duration"]
const UPSTREAM_EXT_VALUES = ["ZBytesSerializer","ZBytesDeserializer","zserialize","zdeserialize","NumberFormat","BigIntFormat","ZS","ZD"]

// referencing each type keeps the type-only imports checked
export type UpstreamTypes = [IntoKeyExpr, IntoZBytes, PublisherPutOptions, PublisherDeleteOptions, IntoSelector, IntoParameters, ReplyOptions, ReplyErrOptions, ReplyDelOptions, DeleteOptions, PutOptions, GetOptions, QueryableOptions, QuerierOptions, PublisherOptions, SubscriberOptions, IntoEncoding, QuerierGetOptions, ChannelReceiver<unknown>, ChannelSender<unknown>, TryReceived<unknown>, MatchingListenerOptions, TransportEventsListenerOptions, LinkEventsListenerOptions, ZSerializeable, ZDeserializeable]

Deno.test("API parity: every value zenoh-ts exports", () => {
    for (const name of UPSTREAM_VALUES) {
        assert(name in zenoh, `missing export ${name}`)
    }
    for (const name of UPSTREAM_EXT_VALUES) {
        assert(name in ext, `missing ext export ${name}`)
    }
})
