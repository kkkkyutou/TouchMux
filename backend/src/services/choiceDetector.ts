import type { ChoiceOverlay } from "../types/models.js";

const hiddenOverlay: ChoiceOverlay = {
  visible: false,
  source: "",
  options: [],
  excerpt: "",
  detectedAt: 0,
};

export function detectChoiceOverlay(buffer: string): ChoiceOverlay {
  // 暂时关闭选择项识别。当前启发式规则误报较多，先避免打断正常对话流。
  void buffer;
  return hiddenOverlay;

  /*
  const excerpt = buffer
    .slice(-4000)
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-_]/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(/\r\n?/g, "\n")
    .slice(-1200);
  const numberedMatches = [...excerpt.matchAll(/(?:^|\n)\s*(\d+)\.\s+([^\n]+)/g)];
  if (numberedMatches.length >= 2 && numberedMatches.length <= 6) {
    const options = numberedMatches.map((match) => ({
      id: crypto.randomUUID(),
      label: `${match[1]}. ${match[2].trim()}`,
      send: `${match[1]}\r`,
    }));
    return buildOverlay("numbered-options", excerpt, options);
  }

  const yesNoMatch = excerpt.match(/\[([Yy])\/([Nn])\]|\(([Yy])\/([Nn])\)|\b(?:yes\/no|y\/n)\b/i);
  if (yesNoMatch) {
    return buildOverlay("yes-no", excerpt, [
      { id: crypto.randomUUID(), label: "是", send: "y\r" },
      { id: crypto.randomUUID(), label: "否", send: "n\r" },
    ]);
  }

  const trustMatch = excerpt.match(/trust.*folder|是否信任文件夹|trust this folder/i);
  if (trustMatch) {
    return buildOverlay("trust-folder", excerpt, [
      { id: crypto.randomUUID(), label: "信任", send: "y\r" },
      { id: crypto.randomUUID(), label: "不信任", send: "n\r" },
    ]);
  }

  const continueMatch = excerpt.match(/continue|继续|resume|恢复/i);
  const cancelMatch = excerpt.match(/cancel|取消|abort|停止/i);
  if (continueMatch && cancelMatch) {
    return buildOverlay("continue-cancel", excerpt, [
      { id: crypto.randomUUID(), label: "继续", send: "\r" },
      { id: crypto.randomUUID(), label: "取消", send: "\u0003" },
    ]);
  }

  return hiddenOverlay;
  */
}
