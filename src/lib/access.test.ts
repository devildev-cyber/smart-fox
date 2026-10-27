import { test } from "node:test";
import assert from "node:assert/strict";
import { AccessError, assertAccess } from "./access";
import { isSupabaseConfigured } from "./supabase";

const configured = isSupabaseConfigured();

function req(token?: string) {
  return new Request("http://localhost/api/x", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

function stubFetch(statuses: number[]) {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    const status = statuses[Math.min(calls, statuses.length - 1)];
    calls += 1;
    return new Response("{}", { status });
  }) as typeof fetch;
  return {
    get calls() {
      return calls;
    },
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

test("access: rejects requests without a token", { skip: !configured }, async () => {
  await assert.rejects(() => assertAccess(req()), AccessError);
});

test("access: re-checks Supabase after 30s so a revoked session stops working", { skip: !configured }, async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const f = stubFetch([200, 403]);
  try {
    await assertAccess(req("tok-revoke"));
    t.mock.timers.tick(10_000);
    await assertAccess(req("tok-revoke")); // cached
    assert.equal(f.calls, 1);

    t.mock.timers.tick(31_000);
    await assert.rejects(() => assertAccess(req("tok-revoke")), { status: 401 });
    assert.equal(f.calls, 2);
  } finally {
    f.restore();
  }
});

test("access: a Supabase 5xx is not treated as a revocation", { skip: !configured }, async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 2_000_000 });
  const f = stubFetch([200, 503]);
  try {
    await assertAccess(req("tok-outage"));
    t.mock.timers.tick(60_000);
    await assertAccess(req("tok-outage")); // 503 -> falls back to recent verification
    assert.equal(f.calls, 2);
  } finally {
    f.restore();
  }
});
