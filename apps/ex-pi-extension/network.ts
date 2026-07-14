import { networkInterfaces, release } from "node:os";

const LOOPBACK_HOST = "127.0.0.1";
const ALL_INTERFACES_HOST = "0.0.0.0";

function isWsl(): boolean {
	return process.platform === "linux" && release().toLowerCase().includes("microsoft");
}

function configuredHost(name: "EX_PLANNOTATOR_BIND_HOST" | "EX_PLANNOTATOR_HOST"): string | null {
	const value = process.env[name]?.trim();
	return value || null;
}

function wslAddress(): string | null {
	const interfaces = networkInterfaces();
	const candidates = [
		...(interfaces.eth0 ?? []),
		...Object.entries(interfaces)
			.filter(([name]) => name !== "eth0" && !/^(?:lo|docker|br-|veth|tailscale)/.test(name))
			.flatMap(([, addresses]) => addresses ?? []),
	];
	return candidates.find((address) => address.family === "IPv4" && !address.internal)?.address ?? null;
}

export function getExPlannotatorBindHost(): string {
	return configuredHost("EX_PLANNOTATOR_BIND_HOST") ?? (isWsl() ? ALL_INTERFACES_HOST : LOOPBACK_HOST);
}

export function getExPlannotatorUrl(port: number): string {
	const host = configuredHost("EX_PLANNOTATOR_HOST") ?? (isWsl() ? wslAddress() : null) ?? LOOPBACK_HOST;
	const formattedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
	return `http://${formattedHost}:${port}`;
}
