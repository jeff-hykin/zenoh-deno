//
// Copyright (c) 2024 ZettaScale Technology
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

//  ██████  ██████  ███    ██ ███████ ██  ██████
// ██      ██    ██ ████   ██ ██      ██ ██
// ██      ██    ██ ██ ██  ██ █████   ██ ██   ███
// ██      ██    ██ ██  ██ ██ ██      ██ ██    ██
//  ██████  ██████  ██   ████ ██      ██  ██████

/**
 * The configuration for a Zenoh Session.
 *
 * Two kinds of session:
 * - over a websocket to a zenohd remote-api plugin, as in zenoh-ts: `new Config("ws/127.0.0.1:10000")`
 * - in this process, through the native library: `new Config()` (a peer with zenoh's defaults),
 *   `new Config("tcp/192.168.1.5:7447")` (a client of that router), or any zenoh config with
 *   {@link Config.fromJson5}, {@link Config.fromObject} or {@link Config.fromFile}, adjusted with
 *   {@link Config.insertJson5}.
 */
export class Config {
  /** @internal zenoh config (JSON5) for an in-process session */
  private json5_: string = "{}";
  /** @internal [path, JSON5 value] pairs applied on top of json5_ */
  private inserts_: Array<[string, string]> = [];

  /**
   * Construct a new config, containing a locator
   * @param {string} locator - Where to connect.
   * - `ws/<address>` or `wss/<address>` (or `ws://`, `wss://` urls): the websocket of a zenohd
   *   remote-api plugin, exactly as in zenoh-ts.
   * - any other zenoh locator, e.g. `tcp/127.0.0.1:7447`: an in-process session in client mode, connected to it.
   * - empty (the default): an in-process session with zenoh's default config (peer mode, multicast scouting).
   * @param {number} messageResponseTimeoutMs - timeout value in milliseconds for receiving a response from zenoh-plugin-remote-api.
   * Defaults to 500 ms.
   * @returns {Config} configuration instance
   */
  constructor(public locator: string = "", public messageResponseTimeoutMs: number = 500) {
    if (locator !== "" && !Config.isRemoteApiLocator(locator)) {
      this.inserts_.push(["mode", JSON.stringify("client")], ["connect/endpoints", JSON.stringify([locator])]);
    }
  }

  /** zenoh's default config: a peer that finds others by multicast scouting. */
  static default(): Config {
    return new Config();
  }

  /** A zenoh config in JSON5, the format of zenohd's config files. */
  static fromJson5(json5: string): Config {
    const config = new Config();
    config.json5_ = json5;
    return config;
  }

  /** A zenoh config as an object, e.g. `{ mode: "client", connect: { endpoints: ["tcp/10.0.0.2:7447"] } }`. */
  static fromObject(config: Record<string, unknown>): Config {
    return Config.fromJson5(JSON.stringify(config));
  }

  /** A zenoh config file (JSON5). Needs --allow-read. */
  static fromFile(path: string | URL): Config {
    return Config.fromJson5(Deno.readTextFileSync(path));
  }

  /**
   * Sets one setting, like zenoh's `insert_json5`: `path` is slash-separated
   * (`"transport/shared_memory/enabled"`) and `value` is JSON5 text (`"true"`, `'"client"'`, `'["tcp/[::]:0"]'`).
   */
  insertJson5(path: string, value: string): this {
    if (this.isRemoteApi()) {
      throw new Error("insertJson5 configures an in-process session; this config connects to a remote-api plugin");
    }
    this.inserts_.push([path, value]);
    return this;
  }

  /** Whether this config connects to a zenohd remote-api plugin over a websocket (zenoh-ts's way). */
  isRemoteApi(): boolean {
    return Config.isRemoteApiLocator(this.locator);
  }

  /** @internal what the native library's zd_open takes */
  toNative_(): string {
    return JSON.stringify({ config: this.json5_, inserts: this.inserts_ });
  }

  private static isRemoteApiLocator(locator: string): boolean {
    return /^wss?(\/|:\/\/)/.test(locator);
  }
}
