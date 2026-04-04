import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeRollout(baseHome, isoDate, sessionId, lines) {
  const date = new Date(isoDate);
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const dirPath = path.join(baseHome, ".codex", "sessions", year, month, day);
  ensureDir(dirPath);
  const filePath = path.join(dirPath, `rollout-${isoDate.replaceAll(":", "-")}-${sessionId}.jsonl`);
  fs.writeFileSync(filePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  return filePath;
}

function sessionMeta({ timestamp, sessionId, cwd }) {
  return {
    timestamp,
    type: "session_meta",
    payload: {
      id: sessionId,
      timestamp,
      cwd,
      originator: "codex_cli_rs",
      source: "cli",
    },
  };
}

function eventMsg(timestamp, payload) {
  return {
    timestamp,
    type: "event_msg",
    payload,
  };
}

function buildSession({
  id,
  workspaceRoot,
  cwd = ".",
  createdAt,
  sourceCodexSessionId = null,
  currentCodexSessionId = null,
  mode = "new",
  successKeywords = ["SUCCESS"],
}) {
  return {
    id,
    nodeId: "local",
    title: id,
    mode,
    status: "running",
    cwd,
    workspaceRoot,
    tmuxSessionName: `touchmux_${id}`,
    sourceCodexSessionId,
    currentCodexSessionId,
    prompt: null,
    command: "codex --no-alt-screen",
    createdAt,
    updatedAt: createdAt,
    lastOutputAt: null,
    lastOutputPreview: "",
    goalState: "running",
    guardDecisionState: "observing_output",
    guardDecisionReason: null,
    successEvidence: null,
    goalConfig: {
      enabled: true,
      goalText: "完成任务",
      successKeywords,
      successCommand: null,
      idleTimeoutSec: 90,
      resumePromptTemplate: "继续执行既定目标，未完成前不要停止。完成后请输出 SUCCESS。",
      allowManualStopAfterSuccess: true,
    },
  };
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "touchmux-codex-observer-"));
  process.env.TOUCHMUX_SESSION_HOME = tempRoot;

  const { CodexObserver } = await import("../backend/dist/services/codexObserver.js");
  const observer = new CodexObserver();

  const workspaceRoot = path.join(tempRoot, "workspace");
  ensureDir(workspaceRoot);

  const runningSessionId = "sess-running";
  writeRollout(tempRoot, "2026-04-03T10:00:00.000Z", runningSessionId, [
    sessionMeta({
      timestamp: "2026-04-03T10:00:00.000Z",
      sessionId: runningSessionId,
      cwd: workspaceRoot,
    }),
    eventMsg("2026-04-03T10:00:03.000Z", {
      type: "task_started",
      turn_id: "turn-running",
    }),
    eventMsg("2026-04-03T10:00:05.000Z", {
      type: "exec_command_begin",
      command: ["npm", "run", "build"],
    }),
  ]);

  const runningSession = buildSession({
    id: "local-running",
    workspaceRoot,
    createdAt: Date.parse("2026-04-03T09:59:58.000Z"),
  });
  const runningObservation = observer.inspectSession(runningSession, {
    sinceTimestamp: Date.parse("2026-04-03T09:59:58.000Z"),
    goalConfig: runningSession.goalConfig,
  });
  assert.equal(runningObservation.available, true, "observer 应能按 cwd + 时间窗口匹配 rollout");
  assert.equal(runningObservation.matchedBy, "cwd_timestamp", "observer 应记录 cwd_timestamp 匹配方式");
  assert.equal(runningObservation.turnState, "running", "task_started 后应识别为 running");
  assert.deepEqual(runningObservation.recentCommands, ["npm run build"], "应能抽取结构化命令事件");

  const fatalSessionId = "sess-fatal";
  writeRollout(tempRoot, "2026-04-03T11:00:00.000Z", fatalSessionId, [
    sessionMeta({
      timestamp: "2026-04-03T11:00:00.000Z",
      sessionId: fatalSessionId,
      cwd: workspaceRoot,
    }),
    eventMsg("2026-04-03T10:59:50.000Z", {
      type: "error",
      message: "exceeded retry limit, last status: 429 Too Many Requests",
    }),
    eventMsg("2026-04-03T11:00:10.000Z", {
      type: "task_started",
      turn_id: "turn-fatal",
    }),
    eventMsg("2026-04-03T11:00:11.000Z", {
      type: "error",
      message: "network error: connection failed",
    }),
  ]);

  const fatalSession = buildSession({
    id: "local-fatal",
    workspaceRoot,
    createdAt: Date.parse("2026-04-03T11:00:00.000Z"),
  });
  const fatalObservation = observer.inspectSession(fatalSession, {
    sinceTimestamp: Date.parse("2026-04-03T11:00:00.000Z"),
    goalConfig: fatalSession.goalConfig,
  });
  assert.equal(
    fatalObservation.fatalError,
    "network error: connection failed",
    "fatal error 应忽略本轮开始前的旧错误，只保留当前 turn 之后的阻塞错误",
  );

  const successSessionId = "sess-success";
  writeRollout(tempRoot, "2026-04-03T12:00:00.000Z", successSessionId, [
    sessionMeta({
      timestamp: "2026-04-03T12:00:00.000Z",
      sessionId: successSessionId,
      cwd: workspaceRoot,
    }),
    eventMsg("2026-04-03T12:00:01.000Z", {
      type: "task_started",
      turn_id: "turn-success",
    }),
    eventMsg("2026-04-03T12:00:02.000Z", {
      type: "agent_message",
      phase: "final_answer",
      message: "任务已完成。\nSUCCESS\n",
    }),
    eventMsg("2026-04-03T12:00:03.000Z", {
      type: "task_complete",
      turn_id: "turn-success",
    }),
  ]);

  const successSession = buildSession({
    id: "local-success",
    workspaceRoot,
    createdAt: Date.parse("2026-04-03T12:00:00.000Z"),
  });
  const successObservation = observer.inspectSession(successSession, {
    sinceTimestamp: Date.parse("2026-04-03T12:00:00.000Z"),
    goalConfig: successSession.goalConfig,
  });
  assert.equal(successObservation.turnState, "completed", "task_complete 后应识别为 completed");
  assert.equal(successObservation.matchedStandaloneSuccess, true, "独立 SUCCESS 应被识别为高置信成功信号");

  const keywordOnlySessionId = "sess-keyword-only";
  writeRollout(tempRoot, "2026-04-03T13:00:00.000Z", keywordOnlySessionId, [
    sessionMeta({
      timestamp: "2026-04-03T13:00:00.000Z",
      sessionId: keywordOnlySessionId,
      cwd: workspaceRoot,
    }),
    eventMsg("2026-04-03T13:00:01.000Z", {
      type: "agent_message",
      phase: "final_answer",
      message: "这里解释为什么后续应输出 SUCCESS，但当前还没真正结束。",
    }),
  ]);

  const keywordOnlySession = buildSession({
    id: "local-keyword-only",
    workspaceRoot,
    createdAt: Date.parse("2026-04-03T13:00:00.000Z"),
  });
  const keywordOnlyObservation = observer.inspectSession(keywordOnlySession, {
    sinceTimestamp: Date.parse("2026-04-03T13:00:00.000Z"),
    goalConfig: keywordOnlySession.goalConfig,
  });
  assert.equal(keywordOnlyObservation.matchedStandaloneSuccess, false, "普通句子里提到 SUCCESS 不能被当成独立成功标记");
  assert.equal(keywordOnlyObservation.matchedSuccessKeyword, "SUCCESS", "关键词命中应保留为调试信号");

  const sourceIdSessionId = "sess-source-id";
  writeRollout(tempRoot, "2026-04-03T14:00:00.000Z", sourceIdSessionId, [
    sessionMeta({
      timestamp: "2026-04-03T14:00:00.000Z",
      sessionId: sourceIdSessionId,
      cwd: path.join(tempRoot, "other-workspace"),
    }),
  ]);

  const sourceIdSession = buildSession({
    id: "local-source-id",
    workspaceRoot,
    createdAt: Date.parse("2026-04-03T14:00:00.000Z"),
    mode: "resume",
    sourceCodexSessionId: sourceIdSessionId,
  });
  const sourceIdObservation = observer.inspectSession(sourceIdSession, {
    sinceTimestamp: Date.parse("2026-04-03T14:00:00.000Z"),
    goalConfig: sourceIdSession.goalConfig,
  });
  assert.equal(sourceIdObservation.matchedBy, "source_session_id", "当 sourceCodexSessionId 可用时应优先精确匹配");
  assert.equal(sourceIdObservation.matchedSessionId, sourceIdSessionId, "sourceCodexSessionId 精确匹配应返回正确 session id");

  const currentIdSession = buildSession({
    id: "local-current-id",
    workspaceRoot,
    createdAt: Date.parse("2026-04-03T14:00:00.000Z"),
    currentCodexSessionId: sourceIdSessionId,
  });
  const currentIdObservation = observer.inspectSession(currentIdSession, {
    sinceTimestamp: Date.parse("2026-04-03T14:00:00.000Z"),
    goalConfig: currentIdSession.goalConfig,
  });
  assert.equal(currentIdObservation.matchedBy, "current_session_id", "当 currentCodexSessionId 可用时应优先走当前会话精确匹配");
  assert.equal(currentIdObservation.matchedSessionId, sourceIdSessionId, "currentCodexSessionId 精确匹配应返回正确 session id");

  console.log("smoke-codex-observer: ok");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
