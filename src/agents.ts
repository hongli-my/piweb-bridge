/**
 * agents.ts — subagent / extension / skill 辅助函数。
 *
 * 从原 pi-bridge.ts 提取，逻辑不变。读写 ~/.pi/agent 下的 agents/extensions/skills。
 */
import { readdir, readFile, writeFile, mkdir, rm, rename, stat } from "node:fs/promises";
import path from "node:path";
import { parseFrontmatter, loadSkills } from "@earendil-works/pi-coding-agent";
import { RESOLVED_AGENT_DIR, CWD, readSettings, pathExists } from "./config.ts";

async function listAgents(): Promise<any[]> {
  const dir = path.join(RESOLVED_AGENT_DIR, "agents");
  const out: any[] = [];
  let entries: any[] = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const name = e.name;
    const subDir = path.join(dir, name);
    let file = path.join(subDir, name + ".md");
    if (!await pathExists(file)) {
      let files: string[] = [];
      try { files = await readdir(subDir); } catch { continue; }
      const md = files.find(f => f.endsWith(".md"));
      if (!md) continue;
      file = path.join(subDir, md);
    }
    let content = "";
    try { content = await readFile(file, "utf8"); } catch { continue; }
    const { frontmatter, body } = parseFrontmatter<any>(content);
    const toArray = (v: any): string[] => {
      if (Array.isArray(v)) return v.map(String);
      if (typeof v === "string") return v.split(",").map((s: string) => s.trim()).filter(Boolean);
      return [];
    };
    out.push({
      name: String(frontmatter.name || name),
      description: String(frontmatter.description || ""),
      model: frontmatter.model ? String(frontmatter.model) : "",
      tools: toArray(frontmatter.tools),
      systemPromptMode: String(frontmatter.systemPromptMode || "append"),
      inheritProjectContext: frontmatter.inheritProjectContext !== false,
      inheritSkills: frontmatter.inheritSkills !== false,
      defaultContext: String(frontmatter.defaultContext || "fresh"),
      skills: toArray(frontmatter.skills),
      skillPath: frontmatter.skillPath ? String(frontmatter.skillPath) : "",
      hasSkillsDir: await pathExists(path.join(subDir, "skills")),
      dir: subDir, file,
      body: (body || "").trim(),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function serializeAgent(fm: Record<string, any>, body: string): string {
  const order = ["name", "description", "model", "tools", "systemPromptMode", "inheritProjectContext", "inheritSkills", "defaultContext", "skillPath", "skills", "acceptance", "acceptanceRole", "agentContract"];
  const lines = ["---"];
  const seen = new Set<string>();
  const fmt = (v: any): string => {
    if (Array.isArray(v)) return v.join(", ");
    if (typeof v === "boolean") return v ? "true" : "false";
    return String(v);
  };
  for (const k of order) {
    if (fm[k] === undefined || fm[k] === null || fm[k] === "") continue;
    if (Array.isArray(fm[k]) && fm[k].length === 0) continue;
    seen.add(k);
    lines.push(`${k}: ${fmt(fm[k])}`);
  }
  for (const k of Object.keys(fm)) {
    if (seen.has(k)) continue;
    if (fm[k] === undefined || fm[k] === null || fm[k] === "") continue;
    if (Array.isArray(fm[k]) && fm[k].length === 0) continue;
    lines.push(`${k}: ${fmt(fm[k])}`);
  }
  lines.push("---", "", (body || "").trim());
  return lines.join("\n") + "\n";
}

async function listExtensions(): Promise<any[]> {
  const out: any[] = [];
  const localDir = path.join(RESOLVED_AGENT_DIR, "extensions");
  let entries: any[] = [];
  try { entries = await readdir(localDir, { withFileTypes: true }); } catch {}
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const name = e.name;
    const fullPath = path.join(localDir, name);
    const info: any = { name, type: "local", path: fullPath };
    try {
      const pkg = JSON.parse(await readFile(path.join(fullPath, "package.json"), "utf8"));
      info.description = pkg.description || "";
      info.version = pkg.version || "";
      if (pkg.pi) info.pi = pkg.pi;
    } catch {}
    out.push(info);
  }
  const settings = await readSettings();
  const packages: any[] = settings.packages || [];
  for (const pkg of packages) {
    const src = typeof pkg === "string" ? pkg : (pkg && pkg.source);
    if (typeof src !== "string") continue;
    if (src.startsWith("npm:")) {
      const pkgName = src.slice(4);
      const realPath = path.join(RESOLVED_AGENT_DIR, "npm", "node_modules", pkgName);
      const info: any = { name: pkgName, type: "package", source: src, path: realPath, configured: true };
      try {
        const p = JSON.parse(await readFile(path.join(realPath, "package.json"), "utf8"));
        info.description = p.description || "";
        info.version = p.version || "";
      } catch { info.installed = false; }
      out.push(info);
    } else if (src.startsWith("git+") || src.startsWith("file:") || src.startsWith("/")) {
      out.push({ name: src, type: "path", source: src, path: src, configured: true });
    } else {
      out.push({ name: src, type: "package", source: src, path: "", configured: true });
    }
  }
  return out;
}

async function listAllSkills(): Promise<any[]> {
  try {
    const res = loadSkills({ cwd: CWD, agentDir: RESOLVED_AGENT_DIR, skillPaths: [], includeDefaults: true });
    return (res.skills || []).map((s: any) => ({
      name: s.name, description: s.description || "",
      filePath: s.filePath || "", baseDir: s.baseDir || "",
      disableModelInvocation: !!s.disableModelInvocation,
    }));
  } catch (e: any) {
    console.warn("[pi-bridge] loadSkills failed:", e.message);
    return [];
  }
}

// ---- Route handlers ----
export async function handleAgentsRoute(p: string, m: string, body: any, json: (o: any, s?: number) => Response): Promise<Response | null> {
  if (p === "/agents" && m === "GET") return json({ ok: true, data: await listAgents() });

  const agentMatch = p.match(/^\/agents\/([^/]+)$/);
  if (agentMatch && m === "GET") {
    const list = await listAgents();
    const a = list.find(x => x.name === agentMatch[1] || path.basename(x.dir) === agentMatch[1]);
    if (!a) return json({ ok: false, error: "agent not found" }, 404);
    return json({ ok: true, data: a });
  }
  if (agentMatch && m === "DELETE") {
    const dir = path.join(RESOLVED_AGENT_DIR, "agents", agentMatch[1]);
    if (!await pathExists(dir)) return json({ ok: false, error: "not found" }, 404);
    await rm(dir, { recursive: true, force: true });
    return json({ ok: true });
  }
  if (p === "/agents" && m === "POST") {
    const name = String(body.name || "").trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) return json({ ok: false, error: "invalid name (a-z 0-9 _ -)" }, 400);
    const agentDir = path.join(RESOLVED_AGENT_DIR, "agents", name);
    if (await pathExists(agentDir)) return json({ ok: false, error: "agent already exists" }, 409);
    await mkdir(agentDir, { recursive: true });
    const file = path.join(agentDir, name + ".md");
    const fm: Record<string, any> = {
      name, description: body.description || "", model: body.model || "",
      tools: body.tools || [], systemPromptMode: body.systemPromptMode || "append",
      inheritProjectContext: body.inheritProjectContext !== false,
      inheritSkills: body.inheritSkills !== false,
      defaultContext: body.defaultContext || "fresh",
      skillPath: body.skillPath || "", skills: body.skills || [],
    };
    await writeFile(file, serializeAgent(fm, body.body || ""), "utf8");
    return json({ ok: true, data: { ...fm, dir: agentDir, file, body: (body.body || "").trim(), hasSkillsDir: false } });
  }
  if (agentMatch && m === "PATCH") {
    const oldName = agentMatch[1];
    const list = await listAgents();
    const a = list.find(x => x.name === oldName || path.basename(x.dir) === oldName);
    if (!a) return json({ ok: false, error: "agent not found" }, 404);
    const newName = String(body.name || a.name).trim();
    let dir = a.dir, file = a.file, finalName = a.name;
    if (newName !== a.name && newName) {
      if (!/^[a-zA-Z0-9_-]+$/.test(newName)) return json({ ok: false, error: "invalid name" }, 400);
      const newDir = path.join(RESOLVED_AGENT_DIR, "agents", newName);
      if (await pathExists(newDir)) return json({ ok: false, error: "name already exists" }, 409);
      await rename(a.dir, newDir);
      const oldFile = path.join(newDir, path.basename(a.file));
      const newFile = path.join(newDir, newName + ".md");
      if (await pathExists(oldFile)) await rename(oldFile, newFile);
      dir = newDir; file = newFile; finalName = newName;
    }
    const fm: Record<string, any> = {
      name: finalName,
      description: body.description !== undefined ? body.description : a.description,
      model: body.model !== undefined ? body.model : a.model,
      tools: body.tools !== undefined ? body.tools : a.tools,
      systemPromptMode: body.systemPromptMode !== undefined ? body.systemPromptMode : a.systemPromptMode,
      inheritProjectContext: body.inheritProjectContext !== undefined ? body.inheritProjectContext : a.inheritProjectContext,
      inheritSkills: body.inheritSkills !== undefined ? body.inheritSkills : a.inheritSkills,
      defaultContext: body.defaultContext !== undefined ? body.defaultContext : a.defaultContext,
      skillPath: body.skillPath !== undefined ? body.skillPath : a.skillPath,
      skills: body.skills !== undefined ? body.skills : a.skills,
    };
    const bodyText = body.body !== undefined ? body.body : a.body;
    await writeFile(file, serializeAgent(fm, bodyText), "utf8");
    return json({ ok: true, data: { ...fm, dir, file, body: (bodyText || "").trim(), hasSkillsDir: a.hasSkillsDir } });
  }
  return null;
}

export async function handleMiscRoute(p: string, m: string, body: any, json: (o: any, s?: number) => Response): Promise<Response | null> {
  if (p === "/extensions" && m === "GET") return json({ ok: true, data: await listExtensions() });
  if ((p === "/skills" || p === "/skills/builtin") && m === "GET") {
    const skills = await listAllSkills();
    return json({ ok: true, skills, data: skills });
  }
  if (p === "/settings" && m === "GET") return json({ ok: true, data: await readSettings() });
  if (p === "/settings" && m === "PATCH") {
    const s = await readSettings();
    Object.assign(s, body);
    const { writeSettings } = await import("./config.ts");
    await writeSettings(s);
    return json({ ok: true, data: s });
  }
  return null;
}
