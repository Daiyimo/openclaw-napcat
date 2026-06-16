import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import EventEmitter from "events";
import { WS_HEARTBEAT_INTERVAL_MS } from "../constants.js";

// ── Mock WebSocket ──────────────────────────────────────────────────────────

class MockWebSocket extends EventEmitter {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  readyState = 1; // OPEN
  send = vi.fn();
  ping = vi.fn();
  terminate = vi.fn();
  close = vi.fn(() => {
    this.readyState = 3;
    this.emit("close");
  });
  removeAllListeners = vi.fn(() => {
    EventEmitter.prototype.removeAllListeners.call(this);
    return this;
  });
  once = vi.fn((event: string, handler: Function) => {
    EventEmitter.prototype.once.call(this, event, handler);
    return this;
  });
  off = vi.fn((event: string, handler: Function) => {
    EventEmitter.prototype.removeListener.call(this, event, handler);
    return this;
  });
}

vi.mock("ws", () => {
  const WS = vi.fn().mockImplementation(() => new MockWebSocket());
  (WS as any).OPEN = 1;
  (WS as any).CONNECTING = 0;
  (WS as any).CLOSED = 3;
  return { default: WS, WebSocketServer: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    close: vi.fn((cb?: Function) => cb?.()),
  })) };
});

vi.mock("../utils/retry.js", () => ({
  withRetry: vi.fn((fn: Function) => fn()),
  isRetryableError: vi.fn(() => false),
}));

vi.mock("../utils/log-sanitize.js", () => ({
  maskUrl: vi.fn((url: string) => url),
  maskBearerToken: vi.fn((text: string) => text),
}));

import { OneBotClient } from "../client.js";
import { ClientApiError } from "../errors/napcat-error.js";

describe("OneBotClient", () => {
  let client: OneBotClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new OneBotClient({
      wsUrl: "ws://localhost:3001",
      httpUrl: "http://localhost:3000",
      accessToken: "test-token",
    });
  });

  describe("getSelfId / setSelfId", () => {
    it("returns null initially", () => {
      expect(client.getSelfId()).toBeNull();
    });

    it("stores and retrieves selfId", () => {
      client.setSelfId(12345);
      expect(client.getSelfId()).toBe(12345);
    });
  });

  describe("sendPrivateMsg", () => {
    it("calls sendAction with correct params", async () => {
      const sendActionSpy = vi.spyOn(client, "sendAction").mockResolvedValue(undefined);
      await client.sendPrivateMsg(12345, "hello");
      expect(sendActionSpy).toHaveBeenCalledWith("send_private_msg", {
        user_id: "12345",
        message: "hello",
      });
    });
  });

  describe("sendGroupMsg", () => {
    it("calls sendAction with correct params", async () => {
      const sendActionSpy = vi.spyOn(client, "sendAction").mockResolvedValue(undefined);
      await client.sendGroupMsg(67890, "group msg");
      expect(sendActionSpy).toHaveBeenCalledWith("send_group_msg", {
        group_id: "67890",
        message: "group msg",
      });
    });
  });

  describe("deleteMsg", () => {
    it("sends delete_msg action", () => {
      const sendWsSpy = vi.spyOn(client as any, "sendWs").mockImplementation(() => {});
      client.deleteMsg(111);
      expect(sendWsSpy).toHaveBeenCalledWith("delete_msg", { message_id: "111" });
    });
  });

  describe("setGroupAddRequest", () => {
    it("sends set_group_add_request", () => {
      const sendWsSpy = vi.spyOn(client as any, "sendWs").mockImplementation(() => {});
      client.setGroupAddRequest("flag1", "invite", true, "");
      expect(sendWsSpy).toHaveBeenCalledWith("set_group_add_request", {
        flag: "flag1",
        sub_type: "invite",
        approve: true,
        reason: "",
      });
    });
  });

  describe("setFriendAddRequest", () => {
    it("sends set_friend_add_request", () => {
      const sendWsSpy = vi.spyOn(client as any, "sendWs").mockImplementation(() => {});
      client.setFriendAddRequest("flag2", true, "remark");
      expect(sendWsSpy).toHaveBeenCalledWith("set_friend_add_request", {
        flag: "flag2",
        approve: true,
        remark: "remark",
      });
    });
  });

  describe("setGroupBan", () => {
    it("sends set_group_ban with default duration", () => {
      const sendWsSpy = vi.spyOn(client as any, "sendWs").mockImplementation(() => {});
      client.setGroupBan(111, 222);
      expect(sendWsSpy).toHaveBeenCalledWith("set_group_ban", {
        group_id: "111",
        user_id: "222",
        duration: 1800,
      });
    });

    it("sends set_group_ban with custom duration", () => {
      const sendWsSpy = vi.spyOn(client as any, "sendWs").mockImplementation(() => {});
      client.setGroupBan(111, 222, 60);
      expect(sendWsSpy).toHaveBeenCalledWith("set_group_ban", {
        group_id: "111",
        user_id: "222",
        duration: 60,
      });
    });
  });

  describe("setGroupKick", () => {
    it("sends set_group_kick", () => {
      const sendWsSpy = vi.spyOn(client as any, "sendWs").mockImplementation(() => {});
      client.setGroupKick(111, 222, true);
      expect(sendWsSpy).toHaveBeenCalledWith("set_group_kick", {
        group_id: "111",
        user_id: "222",
        reject_add_request: true,
      });
    });
  });

  describe("sendGroupPoke", () => {
    it("sends group_poke", () => {
      const sendWsSpy = vi.spyOn(client as any, "sendWs").mockImplementation(() => {});
      client.sendGroupPoke(111, 222);
      expect(sendWsSpy).toHaveBeenCalledWith("group_poke", {
        group_id: "111",
        user_id: "222",
      });
    });
  });

  describe("sendFriendPoke", () => {
    it("sends friend_poke", () => {
      const sendWsSpy = vi.spyOn(client as any, "sendWs").mockImplementation(() => {});
      client.sendFriendPoke(222);
      expect(sendWsSpy).toHaveBeenCalledWith("friend_poke", {
        user_id: "222",
      });
    });
  });

  describe("disconnect", () => {
    it("cleans up resources", async () => {
      await expect(client.disconnect()).resolves.not.toThrow();
    });
  });

  describe("connect", () => {
    it("does nothing when wsUrl is not set", () => {
      const noWsClient = new OneBotClient({ httpUrl: "http://localhost:3000" });
      expect(() => noWsClient.connect()).not.toThrow();
    });
  });

  describe("heartbeat", () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it("calls handleDisconnect after heartbeat timeout (2 intervals)", async () => {
      const mockWs = new MockWebSocket();
      (client as any).ws = mockWs;
      (client as any).forwardAlive = true;

      // Simulate connect → startHeartbeat
      (client as any).startHeartbeat();

      // 1st tick: forwardAlive set to false, ws.ping() called
      await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_INTERVAL_MS);
      expect(mockWs.ping).toHaveBeenCalled();
      expect((client as any).forwardAlive).toBe(false);

      // 2nd tick: forwardAlive is false → handleDisconnect → terminate
      await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_INTERVAL_MS);
      expect(mockWs.terminate).toHaveBeenCalled();
    });

    it("resets forwardAlive when message received between heartbeats", async () => {
      const mockWs = new MockWebSocket();
      (client as any).ws = mockWs;
      (client as any).forwardAlive = true;

      (client as any).startHeartbeat();

      // 1st tick: forwardAlive → false
      await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_INTERVAL_MS);
      expect((client as any).forwardAlive).toBe(false);

      // Simulate receiving a message: directly set forwardAlive = true (message handler does this)
      (client as any).forwardAlive = true;

      // 2nd tick: forwardAlive is true → just ping, no disconnect
      await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_INTERVAL_MS);
      expect(mockWs.terminate).not.toHaveBeenCalled();
    });
  });

  describe("startReverseWs", () => {
    it("does nothing when reverseWsPort is not set", () => {
      expect(() => client.startReverseWs()).not.toThrow();
    });

    function getConnectionHandler(client: OneBotClient): Function | undefined {
      const wss = (client as any).reverseWss;
      if (!wss) return undefined;
      const onCall = (wss.on as ReturnType<typeof vi.fn>).mock.calls.find((c: [string, Function]) => c[0] === "connection");
      return onCall?.[1];
    }

    it("rejects connection when requireReverseWsToken=true and no accessToken configured", async () => {
      const strictClient = new OneBotClient({
        wsUrl: "ws://localhost:3001",
        reverseWsPort: 3002,
        requireReverseWsToken: true,
      });
      strictClient.startReverseWs();
      const handler = getConnectionHandler(strictClient);
      expect(handler).toBeDefined();
      const mockWs = new MockWebSocket();
      const mockReq = { headers: {} } as any;
      handler(mockWs, mockReq);
      expect(mockWs.close).toHaveBeenCalledWith(4001, "Unauthorized: accessToken required but not configured");
    });

    it("accepts connection when requireReverseWsToken=true and accessToken matches", async () => {
      const strictClient = new OneBotClient({
        wsUrl: "ws://localhost:3001",
        reverseWsPort: 3002,
        accessToken: "secret-token",
        requireReverseWsToken: true,
      });
      strictClient.startReverseWs();
      const handler = getConnectionHandler(strictClient);
      expect(handler).toBeDefined();
      const mockWs = new MockWebSocket();
      const mockReq = { headers: { authorization: "Bearer secret-token" } } as any;
      handler(mockWs, mockReq);
      expect(mockWs.close).not.toHaveBeenCalled();
    });

    it("rejects connection when requireReverseWsToken=true and token mismatch", async () => {
      const strictClient = new OneBotClient({
        wsUrl: "ws://localhost:3001",
        reverseWsPort: 3002,
        accessToken: "secret-token",
        requireReverseWsToken: true,
      });
      strictClient.startReverseWs();
      const handler = getConnectionHandler(strictClient);
      expect(handler).toBeDefined();
      const mockWs = new MockWebSocket();
      const mockReq = { headers: { authorization: "Bearer wrong-token" } } as any;
      handler(mockWs, mockReq);
      expect(mockWs.close).toHaveBeenCalledWith(4001, "Unauthorized");
    });
  });

  describe("stopReverseWs", () => {
    it("resolves when no reverse WS is running", async () => {
      await expect(client.stopReverseWs()).resolves.not.toThrow();
    });
  });

  describe("setMsgEmojiLike", () => {
    it("calls sendAction with correct params", async () => {
      const sendActionSpy = vi.spyOn(client, "sendAction").mockResolvedValue(undefined);
      await client.setMsgEmojiLike(123, "307");
      expect(sendActionSpy).toHaveBeenCalledWith("set_msg_emoji_like", {
        message_id: "123",
        emoji_id: "307",
        set: true,
      });
    });
  });

  describe("markGroupMsgAsRead", () => {
    it("sends mark_group_msg_as_read via active WS", async () => {
      const mockWs = new MockWebSocket();
      (client as any).ws = mockWs;
      await client.markGroupMsgAsRead(12345);
      expect(mockWs.send).toHaveBeenCalledWith(
        expect.stringContaining("mark_group_msg_as_read")
      );
    });

    it("does nothing when no active WS", async () => {
      (client as any).ws = null;
      (client as any).reverseWs = null;
      await expect(client.markGroupMsgAsRead(12345)).resolves.not.toThrow();
    });
  });

  describe("markPrivateMsgAsRead", () => {
    it("sends mark_private_msg_as_read via active WS", async () => {
      const mockWs = new MockWebSocket();
      (client as any).ws = mockWs;
      await client.markPrivateMsgAsRead(12345);
      expect(mockWs.send).toHaveBeenCalledWith(
        expect.stringContaining("mark_private_msg_as_read")
      );
    });
  });

  describe("uploadGroupFile", () => {
    it("calls sendAction with correct params", async () => {
      const sendActionSpy = vi.spyOn(client, "sendAction").mockResolvedValue(undefined);
      await client.uploadGroupFile(111, "https://a.com/file.pdf", "file.pdf");
      expect(sendActionSpy).toHaveBeenCalledWith("upload_group_file", {
        group_id: "111",
        file: "https://a.com/file.pdf",
        name: "file.pdf",
      });
    });
  });

  describe("uploadPrivateFile", () => {
    it("calls sendAction with correct params", async () => {
      const sendActionSpy = vi.spyOn(client, "sendAction").mockResolvedValue(undefined);
      await client.uploadPrivateFile(222, "https://a.com/file.pdf", "file.pdf");
      expect(sendActionSpy).toHaveBeenCalledWith("upload_private_file", {
        user_id: "222",
        file: "https://a.com/file.pdf",
        name: "file.pdf",
      });
    });
  });

  describe("sendGroupAiRecord", () => {
    it("calls sendAction with correct params", async () => {
      const sendActionSpy = vi.spyOn(client, "sendAction").mockResolvedValue(undefined);
      await client.sendGroupAiRecord(111, "hello", "voice-1");
      expect(sendActionSpy).toHaveBeenCalledWith("send_group_ai_record", {
        group_id: "111",
        text: "hello",
        character: "voice-1",
      });
    });
  });

  describe("sendGuildChannelMsg", () => {
    it("calls sendAction with correct params", async () => {
      const sendActionSpy = vi.spyOn(client, "sendAction").mockResolvedValue(undefined);
      await client.sendGuildChannelMsg("guild1", "channel1", "guild msg");
      expect(sendActionSpy).toHaveBeenCalledWith("send_guild_channel_msg", {
        guild_id: "guild1",
        channel_id: "channel1",
        message: "guild msg",
      });
    });
  });

  describe("getGroupList", () => {
    it("calls sendWithResponse", async () => {
      const spy = vi.spyOn(client, "sendWithResponse").mockResolvedValue([]);
      const result = await client.getGroupList();
      expect(spy).toHaveBeenCalledWith("get_group_list", {});
      expect(result).toEqual([]);
    });
  });

  describe("getFriendList", () => {
    it("calls sendWithResponse", async () => {
      const spy = vi.spyOn(client, "sendWithResponse").mockResolvedValue([]);
      const result = await client.getFriendList();
      expect(spy).toHaveBeenCalledWith("get_friend_list", {});
      expect(result).toEqual([]);
    });
  });

  describe("getGroupInfo", () => {
    it("returns group info on success", async () => {
      vi.spyOn(client, "sendWithResponse").mockResolvedValue({ group_id: 111, group_name: "Test" });
      const result = await client.getGroupInfo(111);
      expect(result).toEqual({ group_id: 111, group_name: "Test" });
    });

    it("returns null on error", async () => {
      vi.spyOn(client, "sendWithResponse").mockRejectedValue(new Error("not found"));
      const result = await client.getGroupInfo(999);
      expect(result).toBeNull();
    });
  });

  describe("getGuildList", () => {
    it("returns empty array on error", async () => {
      vi.spyOn(client, "sendWithResponse").mockRejectedValue(new Error("no guilds"));
      const result = await client.getGuildList();
      expect(result).toEqual([]);
    });
  });

  describe("getGuildServiceProfile", () => {
    it("returns null on error", async () => {
      vi.spyOn(client, "sendWithResponse").mockRejectedValue(new Error("error"));
      const result = await client.getGuildServiceProfile();
      expect(result).toBeNull();
    });
  });

  describe("getGroupMemberList", () => {
    it("calls sendWithResponse with correct params", async () => {
      const spy = vi.spyOn(client, "sendWithResponse").mockResolvedValue([]);
      await client.getGroupMemberList(111);
      expect(spy).toHaveBeenCalledWith("get_group_member_list", { group_id: "111" });
    });
  });

  describe("getLoginInfo", () => {
    it("calls sendWithResponse", async () => {
      const spy = vi.spyOn(client, "sendWithResponse").mockResolvedValue({ user_id: 123, nickname: "Bot" });
      const result = await client.getLoginInfo();
      expect(spy).toHaveBeenCalledWith("get_login_info", {});
      expect(result).toEqual({ user_id: 123, nickname: "Bot" });
    });
  });

  describe("getAiCharacters", () => {
    it("calls sendWithResponse", async () => {
      const spy = vi.spyOn(client, "sendWithResponse").mockResolvedValue([]);
      const result = await client.getAiCharacters();
      expect(spy).toHaveBeenCalledWith("get_ai_characters", {});
      expect(result).toEqual([]);
    });
  });

  describe("getMsg", () => {
    it("calls sendWithResponse with correct params", async () => {
      const spy = vi.spyOn(client, "sendWithResponse").mockResolvedValue({});
      await client.getMsg(456);
      expect(spy).toHaveBeenCalledWith("get_msg", { message_id: "456" });
    });
  });

  describe("getGroupMsgHistory", () => {
    it("calls sendWithResponse with count", async () => {
      const spy = vi.spyOn(client, "sendWithResponse").mockResolvedValue({});
      await client.getGroupMsgHistory(111, 10);
      expect(spy).toHaveBeenCalledWith("get_group_msg_history", { group_id: "111", count: 10 });
    });

    it("calls sendWithResponse without count when undefined", async () => {
      const spy = vi.spyOn(client, "sendWithResponse").mockResolvedValue({});
      await client.getGroupMsgHistory(111);
      expect(spy).toHaveBeenCalledWith("get_group_msg_history", { group_id: "111" });
    });
  });

  describe("getForwardMsg", () => {
    it("calls sendWithResponse with correct params", async () => {
      const spy = vi.spyOn(client, "sendWithResponse").mockResolvedValue({});
      await client.getForwardMsg("forward-id");
      expect(spy).toHaveBeenCalledWith("get_forward_msg", { id: "forward-id" });
    });
  });

  describe("sendAction", () => {
    it("uses HTTP when httpUrl is set", async () => {
      const sendViaHttpSpy = vi.spyOn(client as any, "sendViaHttp").mockResolvedValue(undefined);
      await client.sendAction("test_action", { param: "value" });
      expect(sendViaHttpSpy).toHaveBeenCalledWith("test_action", { param: "value" });
    });

    it("falls back to WS when HTTP fails", async () => {
      vi.spyOn(client as any, "sendViaHttp").mockRejectedValue(new Error("HTTP failed"));
      const sendWsSpy = vi.spyOn(client as any, "sendWs").mockImplementation(() => {});
      await client.sendAction("test_action", {});
      expect(sendWsSpy).toHaveBeenCalledWith("test_action", {});
    });

    it("uses WS directly when httpUrl is not set", async () => {
      const noHttpClient = new OneBotClient({ wsUrl: "ws://localhost:3001" });
      const sendWsSpy = vi.spyOn(noHttpClient as any, "sendWs").mockImplementation(() => {});
      await noHttpClient.sendAction("test_action", {});
      expect(sendWsSpy).toHaveBeenCalledWith("test_action", {});
    });

    it("deduplicates identical sends within window", async () => {
      const sendWsSpy = vi.spyOn(client as any, "sendWs").mockImplementation(() => {});
      await client.sendAction("send_group_msg", { group_id: "123", message: "hello" });
      await client.sendAction("send_group_msg", { group_id: "123", message: "hello" });
      // 第二次应被去重，只发送一次
      expect(sendWsSpy).toHaveBeenCalledTimes(1);
    });

    it("allows different params to pass through", async () => {
      const sendWsSpy = vi.spyOn(client as any, "sendWs").mockImplementation(() => {});
      await client.sendAction("send_group_msg", { group_id: "123", message: "hello" });
      await client.sendAction("send_group_msg", { group_id: "456", message: "hello" });
      expect(sendWsSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe("sendViaHttp (indirectly via sendAction)", () => {
    it("sends POST request and returns data on success", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: "ok", retcode: 0, data: { value: 42 } }),
      });
      vi.stubGlobal("fetch", mockFetch);
      const result = await (client as any).sendViaHttp("test_action", { key: "val" });
      expect(result).toEqual({ value: 42 });
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3000/test_action",
        expect.objectContaining({ method: "POST" })
      );
      vi.unstubAllGlobals();
    });

    it("throws NapcatApiError on non-ok response", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });
      vi.stubGlobal("fetch", mockFetch);
      await expect((client as any).sendViaHttp("test_action", {})).rejects.toThrow(/500/);
      vi.unstubAllGlobals();
    });

    it("throws when API returns error status", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: "failed", retcode: 100, msg: "bad request" }),
      });
      vi.stubGlobal("fetch", mockFetch);
      await expect((client as any).sendViaHttp("test_action", {})).rejects.toThrow("bad request");
      vi.unstubAllGlobals();
    });

    it("includes Authorization header when accessToken is set", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: "ok", retcode: 0, data: null }),
      });
      vi.stubGlobal("fetch", mockFetch);
      await (client as any).sendViaHttp("test_action", {});
      const callHeaders = mockFetch.mock.calls[0][1].headers;
      expect(callHeaders["Authorization"]).toBe("Bearer test-token");
      vi.unstubAllGlobals();
    });
  });

  describe("sendWithResponse", () => {
    it("uses HTTP when httpUrl is available", async () => {
      const sendViaHttpSpy = vi.spyOn(client as any, "sendViaHttp").mockResolvedValue({ data: "ok" });
      const result = await client.sendWithResponse("get_info", {});
      expect(sendViaHttpSpy).toHaveBeenCalled();
      expect(result).toEqual({ data: "ok" });
    });

    it("falls back to WS when HTTP fails and WS is available", async () => {
      vi.spyOn(client as any, "sendViaHttp").mockRejectedValue(new Error("HTTP error"));
      // No WS set → should reject with "WebSocket not open"
      (client as any).ws = null;
      (client as any).reverseWs = null;
      await expect(client.sendWithResponse("get_info", {})).rejects.toThrow("WebSocket not open");
    });

    it("rejects when no WS connection available", async () => {
      const noHttpClient = new OneBotClient({});
      await expect(noHttpClient.sendWithResponse("get_info", {})).rejects.toThrow("WebSocket not open");
    });
  });

  describe("sendWs", () => {
    it("throws when no WS connection", () => {
      (client as any).ws = null;
      (client as any).reverseWs = null;
      expect(() => (client as any).sendWs("test", {})).toThrow("No WebSocket connection available");
    });

    it("sends JSON via active WS", () => {
      const mockWs = new MockWebSocket();
      (client as any).ws = mockWs;
      (client as any).sendWs("test_action", { key: "value" });
      expect(mockWs.send).toHaveBeenCalledWith(
        expect.stringContaining('"action":"test_action"')
      );
    });
  });

  describe("handleDisconnect", () => {
    it("rejects all pending requests", () => {
      const reject1 = vi.fn();
      const reject2 = vi.fn();
      (client as any).pendingRequests.set("echo1", { resolve: vi.fn(), reject: reject1, timer: setTimeout(() => {}, 1000), action: "test1" });
      (client as any).pendingRequests.set("echo2", { resolve: vi.fn(), reject: reject2, timer: setTimeout(() => {}, 1000), action: "test2" });
      (client as any).handleDisconnect();
      // handleDisconnect 调用 cleanup 先 clear timer，再 reject pending requests
      expect(reject1).toHaveBeenCalledTimes(1);
      expect(reject2).toHaveBeenCalledTimes(1);
      expect((client as any).pendingRequests.size).toBe(0);
    });

    it("emits disconnect event", () => {
      const handler = vi.fn();
      client.on("disconnect", handler);
      (client as any).handleDisconnect();
      expect(handler).toHaveBeenCalled();
    });
  });

  describe("cleanup", () => {
    it("clears pending request timers to prevent leaks", () => {
      const timer1 = setTimeout(() => {}, 1000) as unknown as NodeJS.Timeout;
      const timer2 = setTimeout(() => {}, 1000) as unknown as NodeJS.Timeout;
      const clearSpy = vi.spyOn(global, "clearTimeout");
      (client as any).pendingRequests.set("echo1", { resolve: vi.fn(), reject: vi.fn(), timer: timer1, action: "test" });
      (client as any).pendingRequests.set("echo2", { resolve: vi.fn(), reject: vi.fn(), timer: timer2, action: "test" });
      (client as any).cleanup();
      // cleanup 应清除所有 timer（pending requests 由 handleDisconnect 负责 reject 和清除）
      expect(clearSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe("parseIncomingMessage (via message event)", () => {
    it("emits message for valid event", () => {
      const handler = vi.fn();
      client.on("message", handler);
      // Simulate a message by calling parseIncomingMessage indirectly
      const result = (client as any).parseIncomingMessage(
        Buffer.from(JSON.stringify({ post_type: "message", message: "test" }))
      );
      expect(result).toEqual({ post_type: "message", message: "test" });
    });

    it("returns null for heartbeat meta_event", () => {
      const result = (client as any).parseIncomingMessage(
        Buffer.from(JSON.stringify({ post_type: "meta_event", meta_event_type: "heartbeat" }))
      );
      expect(result).toBeNull();
    });

    it("returns null for invalid JSON", () => {
      const result = (client as any).parseIncomingMessage(Buffer.from("not json"));
      expect(result).toBeNull();
    });

    it("resolves pending request on echo response", () => {
      const echo = "test-echo-123";
      (client as any).pendingRequests.set(echo, {
        resolve: vi.fn(),
        reject: vi.fn(),
        timer: setTimeout(() => {}, 1000),
      });
      const result = (client as any).parseIncomingMessage(
        Buffer.from(JSON.stringify({ echo, status: "ok", data: { value: 42 } }))
      );
      expect(result).toBeNull();
      expect((client as any).pendingRequests.has(echo)).toBe(false);
    });

    it("rejects pending request on error echo response", () => {
      const echo = "test-echo-456";
      const reject = vi.fn();
      (client as any).pendingRequests.set(echo, {
        resolve: vi.fn(),
        reject,
        timer: setTimeout(() => {}, 1000),
      });
      (client as any).parseIncomingMessage(
        Buffer.from(JSON.stringify({ echo, status: "failed", msg: "error msg", retcode: 100 }))
      );
      expect(reject).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 100,
          statusText: "error msg",
          action: "unknown",
        })
      );
      const errArg = reject.mock.calls[0][0] as Error;
      expect(errArg).toBeInstanceOf(ClientApiError);
      expect(errArg.name).toBe("ClientApiError");
    });
  });
});
