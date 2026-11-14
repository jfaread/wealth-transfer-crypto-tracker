// Closed Workerd fixture. All prices and reserves are synthetic test values.
// This worker has no public network access and accepts only the production
// adapter's exact read-only endpoints and ABI methods.
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const UNISWAP = '0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f';
const PANCAKE = '0xca143ce32fe78f1f7019d7d551a6402fc5350c73';
const pools = [
  {network: 'ethereum', pool: '0xf82d8ec196fb0d56c6b82a8b1870f09502a49f88', token: '0xa2b4c0af19cc16a6cfacce81f192b024d625817d',
    quote: WETH, factory: UNISWAP, decimals: 9, tokenIndex: 0, reserves: [10n ** 24n, 2n * 10n ** 18n]},
  {network: 'bsc', pool: '0x933477eba23726ca95a957cb85dbb1957267ef85', token: '0x6ec90334d89dbdc89e08a133271be3d104128edb',
    quote: WBNB, factory: PANCAKE, decimals: 18, tokenIndex: 0, reserves: [10n ** 27n, 2n * 10n ** 18n]},
  {network: 'bsc', pool: '0x7d90deedb9f15c1f8fdaccc3b6bc52dc208e9c9a', token: '0xeb2b7d5691878627eff20492ca7c9a71228d931d',
    quote: WBNB, factory: PANCAKE, decimals: 9, tokenIndex: 1, reserves: [3n * 10n ** 18n, 10n ** 18n]}
];
const word = value => BigInt(value).toString(16).padStart(64, '0');
const address = value => '0x' + value.slice(2).padStart(64, '0');
const sockets = new Set(), headers = {};
let feedCount = 0, rpcCount = 0, blockedCount = 0;
function tick(socket, type = 'update') {
  const prices = {'BTC/USD': 100000, 'ETH/USD': 2000, 'BNB/USD': 600, 'XRP/USD': 1, 'SOL/USD': 100, 'SHIB/USD': 0.00000415};
  socket.send(JSON.stringify({channel: 'ticker', type,
    data: Object.entries(prices).map(([symbol, last]) => ({symbol, last, timestamp: new Date().toISOString()}))}));
}
function rpc(network, call) {
  if (call.method === 'eth_chainId') return network === 'ethereum' ? '0x1' : '0x38';
  if (call.method === 'eth_getBlockByNumber') {
    if (!['latest', '0x100'].includes(call.params[0]) || call.params[1] !== false) throw Error('Unexpected block');
    return headers[network];
  }
  if (call.method !== 'eth_call' || call.params[1] !== '0x100') throw Error('Unexpected method or unpinned state');
  const {to, data} = call.params[0], pool = pools.find(value => value.pool === to), token = pools.find(value => value.token === to);
  if (data === '0x313ce567' && (token || [WETH, WBNB].includes(to))) return '0x' + word(token?.decimals ?? 18);
  if (data.startsWith('0xe6a43905')) {
    const requested = '0x' + data.slice(10, 74).slice(-40), quote = '0x' + data.slice(74).slice(-40);
    const value = pools.find(value => value.token === requested && value.quote === quote && value.network === network && value.factory === to);
    if (!value) throw Error('Unexpected pair');
    return address(value.pool);
  }
  if (!pool || pool.network !== network) throw Error('Unexpected pool');
  if (data === '0x0dfe1681') return address(pool.tokenIndex === 0 ? pool.token : pool.quote);
  if (data === '0xd21220a7') return address(pool.tokenIndex === 0 ? pool.quote : pool.token);
  if (data === '0xc45a0155') return address(pool.factory);
  if (data === '0x0902f1ac') return '0x' + pool.reserves.map(word).join('') + word(BigInt(headers[network].timestamp) - 900n);
  throw Error('Unexpected ABI selector');
}
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.href === 'https://runtime-capture.invalid/state') return Response.json({feedCount, rpcCount, blockedCount});
    if (request.method === 'GET' && url.href === 'https://runtime-capture.invalid/tick') {
      for (const socket of sockets) {try {tick(socket);} catch {sockets.delete(socket);}}
      return Response.json({ok: true});
    }
    if (request.method === 'GET' && url.href === 'https://ws.kraken.com/v2') {
      feedCount++;
      const [client, server] = Object.values(new WebSocketPair()); server.accept();
      server.addEventListener('message', () => {sockets.add(server); tick(server, 'snapshot');});
      server.addEventListener('close', () => sockets.delete(server));
      return new Response(null, {status: 101, webSocket: client});
    }
    const network = url.href === 'https://ethereum-rpc.publicnode.com/' ? 'ethereum'
      : url.href === 'https://bsc-rpc.publicnode.com/' ? 'bsc' : null;
    if (network && request.method === 'POST' && !request.headers.has('Authorization')) {
      rpcCount++;
      headers[network] ||= {number: '0x100', timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16), hash: '0x' + (network === 'ethereum' ? '1' : '2').repeat(64)};
      try {
        const calls = await request.json();
        if (!Array.isArray(calls) || calls.length > 20) throw Error('Unexpected batch');
        return Response.json(calls.map(call => ({jsonrpc: '2.0', id: call.id, result: rpc(network, call)})));
      } catch {blockedCount++; return new Response('Closed RPC fixture rejected the request.', {status: 502});}
    }
    blockedCount++;
    return new Response('Unexpected outbound request blocked by the runtime test.', {status: 502});
  }
};
