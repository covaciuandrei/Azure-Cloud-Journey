import { useId, useState } from "react";
import {
  chooseRoute, containsAddress, evaluateRules, subnetDetails, type DemoFlow, type DemoRoute, type DemoRule,
} from "../../domain/networkingTools.js";

function SubnetExplorer() {
  const inputId = useId();
  const [input, setInput] = useState("10.20.1.0/24");
  const [result, setResult] = useState(() => subnetDetails(input));
  const [error, setError] = useState<string | null>(null);
  return <section className="course-tool" aria-label="Subnet explorer">
    <h3>Explore an address block</h3>
    <p>Change the prefix or address, then calculate. Nothing is created in Azure.</p>
    <form onSubmit={(event) => {
      event.preventDefault();
      try { setResult(subnetDetails(input)); setError(null); }
      catch (reason) { setError(reason instanceof Error ? reason.message : "The address could not be calculated."); }
    }}>
      <label htmlFor={inputId}>IPv4 address and prefix</label>
      <div className="course-tool-input"><input id={inputId} value={input} onChange={(event) => setInput(event.target.value)}
        spellCheck={false} autoComplete="off" aria-invalid={Boolean(error)} placeholder="10.20.1.0/24" />
        <button className="button button-secondary" type="submit">Calculate subnet</button></div>
    </form>
    {error ? <p role="alert" className="notice notice-error">{error}</p> : <div role="status">
      {!result.aligned && <p className="notice">That address sits inside <code>{result.network}</code>.
        A subnet starts at the aligned boundary shown below, not at an arbitrary host address.</p>}
      <dl className="course-tool-results">
        <div><dt>Network block</dt><dd><code>{result.network}</code></dd></div>
        <div><dt>Subnet mask</dt><dd><code>{result.mask}</code></dd></div>
        <div><dt>Network bits / remaining bits</dt><dd>{result.prefix} / {result.hostBits}</dd></div>
        <div><dt>Total addresses</dt><dd>2<sup>{result.hostBits}</sup> = {result.total.toLocaleString()}</dd></div>
        <div><dt>Whole range, including reserved addresses</dt><dd><code>{result.firstAddress}</code> to <code>{result.lastAddress}</code></dd></div>
        {result.azureSubnetSupported && <>
          <div><dt>Azure assignable range</dt><dd><code>{result.firstAssignable}</code> to <code>{result.lastAssignable}</code></dd></div>
          <div><dt>Assignable after Azure's five reservations</dt><dd>{result.total.toLocaleString()} - 5 = {result.assignable!.toLocaleString()}</dd></div>
        </>}
      </dl>
      {result.azureSubnetSupported
        ? <p>Azure keeps the first four addresses and the last address. These are assignable IPs, not a guaranteed VM count.
          Services such as Bastion and Container Apps impose extra subnet-size or address requirements.</p>
        : <p className="notice">{result.reservedOverlap
          ? `This block overlaps ${result.reservedOverlap}, which Azure does not permit in a VNet address space.`
          : "This is a valid IPv4 range, but not a supported Azure IPv4 subnet size. Azure subnets use /2 through /29."}
          {" "}Individual services can require a larger block.</p>}
      <p className="small">This checks address arithmetic, supported sizes and documented reserved ranges.
        It does not check your actual VNet boundaries, overlapping subnets, service delegations or available addresses.</p>
      <p>Try <code>10.20.1.0/25</code>, then <code>10.20.1.128/25</code>. They are two separate 128-address blocks.
        Enter <code>10.20.1.150/25</code> to see which block contains that address.</p>
    </div>}
  </section>;
}

function RouteExplorer() {
  const destinationId = useId();
  const [destination, setDestination] = useState("10.40.1.5");
  const [scenario, setScenario] = useState("default");
  const routes: DemoRoute[] = [
    { id: "local", prefix: "10.20.0.0/16", source: "System", nextHop: "Local virtual network" },
    { id: "peering", prefix: "10.40.0.0/16", source: "System", nextHop: "Peered services VNet" },
    { id: "private-ten", prefix: "10.0.0.0/8", source: "System", nextHop: "None (unconnected private range)" },
    { id: "private-office", prefix: "172.16.0.0/12", source: "System", nextHop: "None (unconnected private range)" },
    { id: "appliance-default", prefix: "0.0.0.0/0", source: "User", nextHop: "Virtual appliance 10.20.3.4" },
    { id: "internet-default", prefix: "0.0.0.0/0", source: "System", nextHop: "Internet" },
    ...(scenario === "specific" ? [{ id: "appliance-specific", prefix: "10.40.0.0/16", source: "User" as const, nextHop: "Virtual appliance 10.20.3.4" }] : []),
    ...(scenario === "bgp" ? [
      { id: "office-custom", prefix: "172.20.0.0/16", source: "User" as const, nextHop: "Virtual appliance 10.20.3.4" },
      { id: "learned", prefix: "172.20.8.0/24", source: "BGP" as const, nextHop: "Virtual network gateway" },
    ] : []),
  ];
  let winner: DemoRoute | null = null;
  let error: string | null = null;
  try {
    winner = chooseRoute(destination, routes);
    if (!["10.20.0.0/16", "10.40.0.0/16", "172.20.0.0/16", "198.51.100.0/24", "203.0.113.0/24"]
      .some((cidr) => containsAddress(cidr, destination))) {
      error = "For this exercise, use an address in 10.20.0.0/16, 10.40.0.0/16, 172.20.0.0/16, 198.51.100.0/24 or 203.0.113.0/24.";
    }
  }
  catch (reason) { error = reason instanceof Error ? reason.message : "The route could not be evaluated."; }
  return <section className="course-tool" aria-label="Route explorer">
    <h3>Which route wins?</h3>
    <p>Imagine these are the effective destination routes on our web VM. Start with the most specific matching prefix,
      not the route's source.</p>
    <div className="course-tool-input">
      <label htmlFor={destinationId}>Destination IP<input id={destinationId} value={destination}
        onChange={(event) => setDestination(event.target.value)} spellCheck={false} aria-invalid={Boolean(error)} /></label>
      <label>Route scenario<select value={scenario} onChange={(event) => {
        setScenario(event.target.value);
        setDestination(event.target.value === "bgp" ? "172.20.8.10" : "10.40.1.5");
      }}>
        <option value="default">Only a default UDR</option>
        <option value="specific">Add a matching /16 UDR</option>
        <option value="bgp">Office traffic: /16 UDR versus /24 BGP</option>
      </select></label>
    </div>
    {error ? <p role="alert" className="notice notice-error">{error}</p> : <>
      <div className="table-scroll"><table><caption>Example effective routes</caption>
        <thead><tr><th>Prefix</th><th>Source</th><th>Next hop</th><th>Decision</th></tr></thead>
        <tbody>{routes.map((route) => <tr key={route.id} className={winner?.id === route.id ? "course-tool-winner" : undefined}>
          <td><code>{route.prefix}</code></td><td>{route.source}</td><td>{route.nextHop}</td>
          <td>{route.id === winner?.id ? "Selected" : !containsAddress(route.prefix, destination) ? "Does not contain the destination"
            : subnetDetails(route.prefix).prefix < subnetDetails(winner!.prefix).prefix ? "A more specific prefix matched" : "Lower priority for the same prefix"}</td>
        </tr>)}</tbody></table></div>
      <p role="status"><strong>{winner ? `${winner.prefix} wins: ${winner.nextHop}.` : "No matching route."}</strong>
        {" "}For identical prefix lengths, this example prefers User, then BGP, then System.</p>
      <p>A <code>0.0.0.0/0</code> UDR does not beat the <code>10.40.0.0/16</code> peering route.
        For the separate office range, BGP <code>172.20.8.0/24</code> beats a less specific
        <code>172.20.0.0/16</code> UDR. It is not competing with a local or peered VNet route.</p>
    </>}
    <p className="small">This is a controlled route-selection exercise, not a full Azure network emulator.
      Only routes needed for the five supported example ranges are shown.
      Service-endpoint routes cannot be overridden, and matching local/peering system routes are preferred over BGP.
      The office example deliberately avoids those exceptions.
      A route does not provide SNAT, open a firewall, or prove the return path works.</p>
  </section>;
}

function NsgExplorer() {
  const sourceId = useId();
  const [source, setSource] = useState("10.20.1.4");
  const [port, setPort] = useState("1433");
  const [protocol, setProtocol] = useState<"TCP" | "UDP">("TCP");
  const [nicAllow, setNicAllow] = useState(false);
  const [subnetDeny, setSubnetDeny] = useState(false);
  const defaults: DemoRule[] = [
    { name: "AllowVNetInBound", priority: 65000, source: "10.20.0.0/16", destination: "10.20.0.0/16", protocol: "Any", port: "*", action: "Allow" },
    { name: "DenyAllInBound", priority: 65500, source: "*", destination: "*", protocol: "Any", port: "*", action: "Deny" },
  ];
  const allow: DemoRule = {
    name: "AllowWebToDatabase", priority: 200, source: "10.20.1.0/24", destination: "10.20.2.0/24",
    protocol: "TCP", port: 1433, action: "Allow",
  };
  const subnet: DemoRule[] = [
    ...(subnetDeny ? [{ ...allow, name: "DenyDatabase", priority: 100, source: "*", action: "Deny" as const }] : []),
    allow, ...defaults,
  ];
  const nic: DemoRule[] = [
    ...(nicAllow ? [allow] : []),
    { ...allow, name: "DenyDatabase", priority: 300, source: "*", action: "Deny" }, ...defaults,
  ];
  let result: { subnet: DemoRule; nic: DemoRule } | null = null;
  let error: string | null = null;
  try {
    const flow: DemoFlow = { source, destination: "10.20.2.5", protocol, port: Number(port) };
    result = { subnet: evaluateRules(flow, subnet), nic: evaluateRules(flow, nic) };
  } catch (reason) { error = reason instanceof Error ? reason.message : "The security rules could not be evaluated."; }
  return <section className="course-tool" aria-label="NSG explorer">
    <h3>Two NSGs, one new connection</h3>
    <p>The web VM tries to reach database VM <code>10.20.2.5</code>. A matching allow is needed at both the database
      subnet and its NIC. We evaluate a new inbound connection only.</p>
    <div className="course-tool-input">
      <label htmlFor={sourceId}>Source IP<input id={sourceId} value={source} onChange={(event) => setSource(event.target.value)} /></label>
      <label>Destination port<input type="number" min="1" max="65535" value={port} onChange={(event) => setPort(event.target.value)} /></label>
      <label>Protocol<select value={protocol} onChange={(event) => setProtocol(event.target.value === "UDP" ? "UDP" : "TCP")}>
        <option>TCP</option><option>UDP</option></select></label>
    </div>
    <label className="course-tool-toggle"><input type="checkbox" checked={nicAllow} onChange={(event) => setNicAllow(event.target.checked)} />
      Add a NIC allow for the web subnet at priority 200</label>
    <label className="course-tool-toggle"><input type="checkbox" checked={subnetDeny} onChange={(event) => setSubnetDeny(event.target.checked)} />
      Add a subnet deny at priority 100</label>
    {error ? <p role="alert" className="notice notice-error">{error}</p> : result && <>
      <div className="table-scroll"><table><caption>First matching rule in each NSG</caption>
        <thead><tr><th>NSG</th><th>Rule</th><th>Priority</th><th>Action</th></tr></thead>
        <tbody>{(["subnet", "nic"] as const).map((name) => <tr key={name}>
          <th>{name === "subnet" ? "Database subnet" : "Database NIC"}</th>
          <td>{result![name].name}</td><td>{result![name].priority}</td><td>{result![name].action}</td>
        </tr>)}</tbody></table></div>
      <p role="status"><strong>{result.subnet.action === "Allow" && result.nic.action === "Allow"
        ? "The two NSGs allow this new flow." : "The two-NSG path blocks this new flow."}</strong>
        {" "}One allow cannot cancel a deny in the other NSG.</p>
    </>}
    <p className="small">The simplified VirtualNetwork rule covers 10.20.0.0/16 only. Real service-tag membership can include
      connected network prefixes. The AzureLoadBalancer default is not part of these test sources.
      Assume a route to the NIC exists; we are not proving internet access, the VM's firewall, its database listener, or authentication.</p>
  </section>;
}
export function CourseInteractive({ tool }: { tool: "subnet" | "routes" | "nsg" }) {
  if (tool === "subnet") return <SubnetExplorer />;
  if (tool === "routes") return <RouteExplorer />;
  return <NsgExplorer />;
}
