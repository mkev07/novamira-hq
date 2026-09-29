// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * ponytail: headless fork — the device-login dialog.
 *
 * While `auth login --device` waits, the connect handlers patch `#device-login`
 * with a native `<dialog>` that opens itself as a modal (`data-init`), so the
 * browser supplies the backdrop, the inert page, focus and Escape. When the
 * login finishes either way, the handler patches the empty placeholder back and
 * the dialog is gone. Closing it early only hides it: the login keeps waiting
 * until the code expires.
 */

import * as ds from "../datastar.js";
import { copyFrom, showModal } from "../expr.js";
import {
  deviceVerificationHref,
  flagAttr,
  html,
  idAttr,
  type Html,
} from "../html.js";

export interface DeviceLoginView {
  /** The site being connected, as the operator entered it. */
  readonly siteUrl: string;
  /** The site's verification page, already checked to be on `siteUrl`'s origin. */
  readonly url: string;
  readonly code: string;
  /** Unix milliseconds; absent when the CLI did not say. */
  readonly expiresAt?: number;
}

const ID = "device-login";

export function renderDeviceLogin(view?: DeviceLoginView): Html {
  if (view === undefined)
    return html`<div${idAttr(ID)}${flagAttr("hidden")}></div>`;

  const site = new URL(view.siteUrl);
  const page = new URL(view.url);
  // Defence in depth at the render boundary: only an HTTPS page on the site.
  if (
    page.protocol !== "https:" ||
    page.username !== "" ||
    page.password !== "" ||
    page.origin !== site.origin
  ) {
    return renderDeviceLogin();
  }
  const cells = Array.from(view.code).map((char) =>
    char === "-"
      ? html`<span class="device-code-dash">–</span>`
      : html`<span class="device-code-cell">${char}</span>`,
  );
  const remaining =
    view.expiresAt === undefined
      ? undefined
      : Math.max(0, Math.round((view.expiresAt - Date.now()) / 1000));

  return html`<dialog${idAttr(ID)} class="device-dialog" aria-labelledby="device-login-title" aria-describedby="device-login-intro"${ds.init(showModal())}>
<header class="device-head"><p class="eyebrow">Authorize site</p><h2 id="device-login-title">Approve ${site.host}</h2><p id="device-login-intro">Enter this code on your site's approval page. Novamira HQ connects as soon as you choose Authorize.</p></header>
<div class="device-code"><p class="sr-only">Code: ${Array.from(view.code).join(" ")}</p><p class="device-code-chars" aria-hidden="true">${cells}</p><div class="device-copy"><button class="button device-copy-button" type="button"${ds.on("click", copyFrom(view.code))}>Copy code</button><span class="clipboard-feedback" role="status"></span></div></div>
<div class="device-open"><a class="button primary device-open-button"${deviceVerificationHref(page.href, view.siteUrl)} target="_blank" rel="noopener noreferrer"${flagAttr("autofocus")}${ds.on("click", copyFrom(view.code))}>Copy code &amp; open approval page<span class="device-open-arrow" aria-hidden="true">↗</span></a><span class="clipboard-feedback" role="status"></span><p class="device-url">${page.host}${page.pathname}${page.search}</p></div>
<ol class="device-steps"><li><span>Sign in as an administrator if WordPress asks.</span></li><li><span>Paste the code and look it up.</span></li><li><span>Choose <strong>Authorize</strong>. This window closes by itself.</span></li></ol>
<footer class="device-foot"><p class="device-wait" role="status"><span class="spinner" aria-hidden="true"></span><span>Waiting for approval</span>${remaining === undefined ? false : html`<span class="device-expiry" role="timer"${ds.expiresAt(view.expiresAt ?? 0)}>Code expires in ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}</span>`}</p><form method="dialog"><button class="button quiet" type="submit">Close</button></form></footer>
</dialog>`;
}
