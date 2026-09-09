export class ApiError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message);
	}
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
	let res: Response;
	try {
		res = await fetch(url, init);
	} catch (e) {
		throw new ApiError(0, `无法连接 API 服务（是否已起动 server？）：${(e as Error).message}`);
	}
	const text = await res.text();
	let data: unknown = null;
	if (text) {
		try {
			data = JSON.parse(text);
		} catch {
			data = { message: text };
		}
	}
	if (!res.ok) {
		const message = (data as { message?: string } | null)?.message ?? `${res.status} ${res.statusText}`;
		throw new ApiError(res.status, message);
	}
	return data as T;
}

export const api = {
	get: <T>(url: string) => request<T>(url),
	post: <T>(url: string, body?: unknown) =>
		request<T>(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: body === undefined ? "{}" : JSON.stringify(body),
		}),
	put: <T>(url: string, body: unknown) =>
		request<T>(url, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
	del: <T>(url: string) => request<T>(url, { method: "DELETE" }),
	upload: <T>(url: string, form: FormData) => request<T>(url, { method: "POST", body: form }),
};
