import net from 'node:net';

export class SmtpError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'SmtpError';
    this.code = code;
  }
}

export async function sendMail({
  host = process.env.SMTP_HOST ?? '127.0.0.1',
  port = Number(process.env.SMTP_PORT ?? 2525),
  from,
  to,
  raw,
  timeoutMs = 5000,
}) {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let buffer = '';
    let stage = 'connect';
    const stages = [];
    let done = false;

    const fail = (error) => {
      if (done) return;
      done = true;
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(timeoutMs, () => fail(new SmtpError('SMTP timeout', 'TRANSPORT_TIMEOUT')));
    socket.on('error', (error) => fail(new SmtpError(error.message, 'TRANSPORT_ERROR')));
    socket.on('close', () => {
      if (!done) fail(new SmtpError('connection closed before final response', 'RESPONSE_LOST'));
    });
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\r\n').filter(Boolean);
      const finalLine = lines.find((line) => /^\d{3}\s/.test(line));
      if (!finalLine) return;
      buffer = '';
      const code = Number(finalLine.slice(0, 3));
      stages.push({ stage, response: finalLine });
      if (code >= 400) {
        fail(new SmtpError(finalLine, code >= 500 ? 'SMTP_PERMANENT' : 'SMTP_TRANSIENT'));
        return;
      }
      if (stage === 'connect') {
        stage = 'ehlo';
        socket.write(`EHLO campaign-workbench\r\n`);
      } else if (stage === 'ehlo') {
        stage = 'from';
        socket.write(`MAIL FROM:<${from}>\r\n`);
      } else if (stage === 'from') {
        stage = 'rcpt';
        socket.write(`RCPT TO:<${to}>\r\n`);
      } else if (stage === 'rcpt') {
        stage = 'data';
        socket.write('DATA\r\n');
      } else if (stage === 'data') {
        stage = 'body';
        socket.write(`${dotStuff(raw)}\r\n.\r\n`);
      } else if (stage === 'body') {
        done = true;
        socket.write('QUIT\r\n');
        socket.end();
        resolve({ response: finalLine, stages });
      }
    });
  });
}

function dotStuff(raw) {
  return raw.replace(/(^|\r\n)\./g, '$1..');
}
