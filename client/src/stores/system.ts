import { defineStore } from "pinia";
import { ref } from "vue";
import type { SystemStatus } from "@shirone-admin/shared";
import { systemApi } from "../api";

export const useSystemStore = defineStore("system", () => {
	const status = ref<SystemStatus | null>(null);

	async function refresh(): Promise<void> {
		status.value = await systemApi.status();
	}

	return { status, refresh };
});
