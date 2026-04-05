import crypto from "node:crypto";
import { db } from "../core/database.js";

export interface GoalGuardTemplateRecord {
  id: string;
  name: string;
  content: string;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
}

export class GoalGuardTemplateService {
  listTemplates(): GoalGuardTemplateRecord[] {
    return db
      .prepare(`
        SELECT id, name, content, is_default, created_at, updated_at
        FROM goal_guard_templates
        ORDER BY is_default DESC, updated_at DESC, created_at DESC
      `)
      .all()
      .map((row) => this.mapRow(row as Record<string, unknown>));
  }

  saveTemplate(input: { id?: string | null; name: string; content: string }): GoalGuardTemplateRecord {
    const name = input.name.trim();
    const content = input.content.trim();
    if (!name) {
      throw new Error("模板名称不能为空");
    }
    if (!content) {
      throw new Error("模板内容不能为空");
    }
    const now = Date.now();
    const id = input.id?.trim() || crypto.randomUUID();
    const existing = db
      .prepare("SELECT id FROM goal_guard_templates WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (existing) {
      db.prepare(`
        UPDATE goal_guard_templates
        SET name = ?, content = ?, updated_at = ?
        WHERE id = ?
      `).run(name, content, now, id);
    } else {
      db.prepare(`
        INSERT INTO goal_guard_templates (id, name, content, is_default, created_at, updated_at)
        VALUES (?, ?, ?, 0, ?, ?)
      `).run(id, name, content, now, now);
    }
    return this.getTemplateOrThrow(id);
  }

  setDefaultTemplate(id: string): GoalGuardTemplateRecord {
    const templateId = id.trim();
    if (!templateId) {
      throw new Error("模板 ID 不能为空");
    }
    db.prepare("UPDATE goal_guard_templates SET is_default = 0").run();
    db.prepare("UPDATE goal_guard_templates SET is_default = 1, updated_at = ? WHERE id = ?").run(Date.now(), templateId);
    return this.getTemplateOrThrow(templateId);
  }

  deleteTemplate(id: string): void {
    const templateId = id.trim();
    if (!templateId) {
      throw new Error("模板 ID 不能为空");
    }
    db.prepare("DELETE FROM goal_guard_templates WHERE id = ?").run(templateId);
  }

  private getTemplateOrThrow(id: string): GoalGuardTemplateRecord {
    const row = db
      .prepare(`
        SELECT id, name, content, is_default, created_at, updated_at
        FROM goal_guard_templates
        WHERE id = ?
      `)
      .get(id) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error("模板不存在");
    }
    return this.mapRow(row);
  }

  private mapRow(row: Record<string, unknown>): GoalGuardTemplateRecord {
    return {
      id: String(row.id),
      name: String(row.name),
      content: String(row.content),
      isDefault: Number(row.is_default ?? 0) === 1,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }
}
