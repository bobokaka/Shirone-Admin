import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DataKind } from "@shirone-admin/shared";
import { DATA_KINDS, readDataFile, writeDataFile } from "../lib/dataFile.js";

const kindParam = z.object({
	kind: z.custom<DataKind>((v) => typeof v === "string" && v in DATA_KINDS, {
		message: `kind 必须是：${Object.keys(DATA_KINDS).join(" / ")}`,
	}),
});

const putSchema = z.object({
	items: z.array(z.record(z.unknown())),
});

export async function dataRoutes(app: FastifyInstance): Promise<void> {
	app.get("/api/data/:kind", async (req) => {
		const { kind } = kindParam.parse(req.params);
		return { kind, items: await readDataFile(kind) };
	});

	app.put("/api/data/:kind", async (req) => {
		const { kind } = kindParam.parse(req.params);
		const { items } = putSchema.parse(req.body);
		const changed = await writeDataFile(kind, items);
		return { ok: true, changed };
	});
}
