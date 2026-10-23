/** The four admission events, in provider order; deliberately no item or result. */
export const capacityMessage = 'Selected model is at capacity. Please try a different model.';
export const capacityLines = [
  '{"type":"thread.started","thread_id":"01a169d6-3c5e-7f83-9d0a-48c8f9bd744d"}',
  '{"type":"turn.started"}',
  JSON.stringify({ type: 'error', message: capacityMessage }),
  JSON.stringify({ type: 'turn.failed', error: { message: capacityMessage } }),
];
const item = (type: string, kind = 'agent_message') => JSON.stringify({ type, item: { id: 'item_1', type: kind, text: capacityMessage, aggregated_output: capacityMessage } });
export const rejectedCapacityStreams: [string, string[]][] = [
  ['arbitrary failure', [...capacityLines.slice(0, 2), JSON.stringify({ type: 'turn.failed', error: { message: 'failed TOKEN-private-4839' } })]],
  ['different message', capacityLines.map((s) => s.replaceAll(capacityMessage, capacityMessage + ' TOKEN-private-4839'))],
  ['error alone', capacityLines.slice(0, 3)],
  ['malformed JSON', [...capacityLines.slice(0, 2), '{broken', ...capacityLines.slice(2)]],
  ...['item.started', 'item.updated', 'item.completed'].map((type): [string, string[]] => [type, [...capacityLines.slice(0, 2), item(type), ...capacityLines.slice(2)]]),
  ['tool output', [...capacityLines.slice(0, 2), item('item.completed', 'command_execution'), ...capacityLines.slice(2)]],
  ['completed turn then failure', [...capacityLines.slice(0, 2), item('item.completed'), '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}', capacityLines[1]!, ...capacityLines.slice(2)]],
];
