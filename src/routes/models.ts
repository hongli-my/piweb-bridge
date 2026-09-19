/**
 * routes/models.ts — 模型 / Provider 选择。
 */
import { json } from "../config.ts";
import { visibleModels, defaultModel, setDefaultModel } from "../config.ts";
import { setModelForAll } from "../session-cache.ts";

export async function handleModelsRoute(p: string, m: string, body: any, jsonFn: (o: any, s?: number) => Response): Promise<Response | null> {
  if (p === "/providers" && m === "GET") {
    const providersMap = new Map<string, any[]>();
    for (const mm of visibleModels) {
      const pv = (mm as any).provider;
      if (!providersMap.has(pv)) providersMap.set(pv, []);
      providersMap.get(pv)!.push(mm);
    }
    const providers = Array.from(providersMap.entries()).map(([name, models]) => ({
      name,
      models: models.map((mm: any) => ({
        id: mm.id, name: mm.name,
        reasoning: !!mm.reasoning,
        contextWindow: mm.contextWindow || 0,
        input: mm.input || [],
      })),
    }));
    return jsonFn({
      ok: true,
      providers,
      current: defaultModel ? { provider: defaultModel.provider, modelId: defaultModel.id, name: defaultModel.name } : null,
      current_provider: defaultModel?.id || "",
    });
  }

  if (p === "/models" && m === "GET") {
    return jsonFn({ ok: true, models: visibleModels.map((mm: any) => ({ id: mm.id, name: mm.name, provider: mm.provider })) });
  }

  if (p === "/model" && m === "POST") {
    let target: any;
    if (body.provider && body.modelId) {
      target = visibleModels.find((mm: any) => mm.provider === body.provider && mm.id === body.modelId);
    } else if (body.modelId) {
      target = visibleModels.find((mm: any) => mm.id === body.modelId);
    } else if (body.provider) {
      target = visibleModels.find((mm: any) => mm.id === body.provider || mm.provider === body.provider);
    }
    if (!target) return jsonFn({ ok: false, error: "model not found" }, 404);
    setDefaultModel(target);
    await setModelForAll(target);
    return jsonFn({ ok: true, data: { provider: target.provider, modelId: target.id, name: target.name } });
  }

  return null;
}
