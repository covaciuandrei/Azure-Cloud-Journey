export function ipv4Number(value: string): number {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) {
    throw new Error("Use four numbers from 0 to 255, such as 10.20.1.4. Do not add leading zeros.");
  }
  return parts.reduce((total, part) => total * 256 + Number(part), 0);
}
export function ipv4Address(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 2 ** 32 - 1) throw new Error("IPv4 value is outside its 32-bit range.");
  return [24, 16, 8, 0].map((bits) => Math.floor(value / 2 ** bits) % 256).join(".");
}
export function subnetDetails(value: string) {
  const parts = value.trim().split("/");
  if (parts.length !== 2 || !/^(0|[1-9]\d?)$/.test(parts[1]!) || Number(parts[1]) > 32) {
    throw new Error("Enter an IPv4 address followed by a prefix from /0 to /32, such as 10.20.1.0/24.");
  }
  const address = ipv4Number(parts[0]!);
  const prefix = Number(parts[1]);
  const hostBits = 32 - prefix;
  const total = 2 ** hostBits;
  const first = Math.floor(address / total) * total;
  const last = first + total - 1;
  const azureSizeSupported = prefix >= 2 && prefix <= 29;
  const reservedRanges = [
    ["224.0.0.0", 4], ["255.255.255.255", 32], ["127.0.0.0", 8],
    ["169.254.0.0", 16], ["168.63.129.16", 32],
  ] as const;
  const reservedOverlap = reservedRanges.find(([address, bits]) => {
    const start = ipv4Number(address);
    return first <= start + 2 ** (32 - bits) - 1 && last >= start;
  });
  const azureSubnetSupported = azureSizeSupported && !reservedOverlap;
  return {
    prefix, hostBits, total, first, last,
    network: `${ipv4Address(first)}/${prefix}`, aligned: first === address,
    mask: ipv4Address(2 ** 32 - total),
    firstAddress: ipv4Address(first), lastAddress: ipv4Address(last),
    azureSubnetSupported, azureSizeSupported,
    reservedOverlap: reservedOverlap ? `${reservedOverlap[0]}/${reservedOverlap[1]}` : null,
    assignable: azureSubnetSupported ? total - 5 : null,
    firstAssignable: azureSubnetSupported ? ipv4Address(first + 4) : null,
    lastAssignable: azureSubnetSupported ? ipv4Address(last - 1) : null,
  };
}
export function containsAddress(cidr: string, address: string): boolean {
  const subnet = subnetDetails(cidr);
  const number = ipv4Number(address);
  return number >= subnet.first && number <= subnet.last;
}
export interface DemoRoute {
  id: string; prefix: string; source: "User" | "BGP" | "System"; nextHop: string;
}
export function chooseRoute(destination: string, routes: readonly DemoRoute[]): DemoRoute | null {
  ipv4Number(destination);
  const priority = { User: 0, BGP: 1, System: 2 };
  const matching = routes.filter((route) => containsAddress(route.prefix, destination));
  return matching.sort((a, b) => subnetDetails(b.prefix).prefix - subnetDetails(a.prefix).prefix ||
    priority[a.source] - priority[b.source])[0] ?? null;
}
export interface DemoRule {
  name: string; priority: number; source: string; destination: string; protocol: "TCP" | "UDP" | "Any";
  port: number | "*"; action: "Allow" | "Deny";
}
export interface DemoFlow { source: string; destination: string; protocol: "TCP" | "UDP"; port: number }
export function evaluateRules(flow: DemoFlow, rules: readonly DemoRule[]): DemoRule {
  ipv4Number(flow.source);
  ipv4Number(flow.destination);
  if (!Number.isInteger(flow.port) || flow.port < 1 || flow.port > 65535) throw new Error("Use a destination port from 1 to 65535.");
  const matches = [...rules].sort((a, b) => a.priority - b.priority).find((rule) =>
    (rule.source === "*" || containsAddress(rule.source, flow.source)) &&
    (rule.destination === "*" || containsAddress(rule.destination, flow.destination)) &&
    (rule.protocol === "Any" || rule.protocol === flow.protocol) &&
    (rule.port === "*" || rule.port === flow.port));
  if (!matches) throw new Error("This example needs an explicit default rule before it can decide the flow.");
  return matches;
}
