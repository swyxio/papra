// All native inference shares the account's controlled gateway. Private prompts
// and results must not enter gateway logs or shared response caches.
export const AI_GATEWAY = {
  id: 'swyx-shared',
  collectLog: false,
  skipCache: true,
} satisfies GatewayOptions;
