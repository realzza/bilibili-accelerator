const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function createElement() {
  return {
    className: "",
    id: "",
    style: {},
    dataset: {},
    classList: {
      add() {},
      remove() {},
      toggle() {}
    },
    appendChild() {},
    addEventListener() {},
    attachShadow() {
      return { appendChild() {} };
    },
    setAttribute() {},
    remove() {}
  };
}

test("page script rewrites playurl JSON parsed by the page", () => {
  const core = fs.readFileSync(path.join(__dirname, "../src/core/rewrite.js"), "utf8");
  const page = fs.readFileSync(path.join(__dirname, "../src/page/bili-accelerator.page.js"), "utf8");
  const storage = new Map();
  const sandbox = {
    URL,
    Date,
    JSON,
    WeakSet,
    Headers,
    Response,
    console: {
      info() {},
      warn() {}
    },
    localStorage: {
      getItem(key) {
        return storage.get(key) || null;
      },
      setItem(key, value) {
        storage.set(key, value);
      }
    },
    document: {
      readyState: "loading",
      documentElement: createElement(),
      head: createElement(),
      addEventListener() {},
      getElementById() {
        return null;
      },
      createElement
    },
    location: {
      reload() {}
    }
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;

  vm.runInNewContext(`${core}\n${page}`, sandbox);

  const parsed = sandbox.JSON.parse(JSON.stringify({
    data: {
      dash: {
        video: [{
          baseUrl: "https://xy153x35x231x78xy.mcdn.bilivideo.cn:8082/v1/resource/video.m4s?abc=1"
        }]
      }
    }
  }));

  const rewritten = parsed.data.dash.video[0].baseUrl;
  assert.equal(new URL(rewritten).hostname, "proxy-tf-all-ws.bilivideo.com");
  assert.equal(sandbox.BiliAccelerator.getStats().rewriteCount, 1);
});
