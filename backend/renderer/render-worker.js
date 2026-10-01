import { renderPublished, validateTemplate } from '../templates/render.js';

process.on('message', (message) => {
  if (message?.type === 'validate') {
    process.send({ id: message.id, type: 'result', result: validateTemplate(message.template) });
  }
  if (message?.type === 'render') {
    if (message.context?.__crashOnce) process.exit(31);
    try {
      process.send({ id: message.id, type: 'result', result: renderPublished(message.template, message.context) });
    } catch (error) {
      process.send({ id: message.id, type: 'error', error: { message: error.message, code: error.code, details: error.details } });
    }
  }
  if (message?.type === 'crash-after-reply') {
    process.send({ id: message.id, type: 'result', result: { ok: true } }, () => process.exit(31));
  }
});
