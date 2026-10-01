import net from 'node:net';
import fs from 'node:fs/promises';

export function startSmtpSimulator({
  port = Number(process.env.SMTP_PORT ?? 2525),
  host = '127.0.0.1',
  outboxFile = process.env.MAIL_OUTBOX,
} = {}) {
  const received = [];
  const server = net.createServer((socket) => {
    let dataPhase = false;
    let dataBuffer = '';
    let envelope = { from: null, to: [] };
    let mode = 'succeed';

    const send = (line) => socket.write(`${line}\r\n`);
    send('220 mail-simulator ESMTP ready');

    socket.on('data', async (chunk) => {
      const text = chunk.toString('utf8');
      if (dataPhase) {
        dataBuffer += text;
        const end = dataBuffer.indexOf('\r\n.\r\n');
        if (end === -1) return;
        const raw = dataBuffer.slice(0, end + 2);
        const headerPart = raw.split(/\r?\n\r?\n/, 1)[0];
        const fail = /^x-sim-fail:\s*(.+)$/mi.exec(headerPart)?.[1]?.trim();
        mode = process.env.SMTP_MODE === 'response-lost' || fail === 'response-lost'
          ? 'response-lost'
          : process.env.SMTP_MODE === 'transient' || fail === 'transient'
            ? 'transient'
            : 'succeed';
        const messageId = /^message-id:\s*(.+)$/mi.exec(headerPart)?.[1]?.trim();
        const existing = received.find((item) => messageId && item.messageId === messageId);
        if (existing) {
          existing.duplicates += 1;
          // A duplicate can arrive because the first DATA response was lost.
          // Accept deterministically so the second attempt becomes a receipt.
          send(`250 OK duplicate idempotent message accepted; event=${existing.id}`);
        } else {
          const item = {
            id: `${Date.now()}-${received.length + 1}`,
            receivedAt: new Date().toISOString(),
            from: envelope.from,
            to: [...envelope.to],
            messageId,
            raw,
            acknowledged: false,
            duplicates: 0,
          };
          received.push(item);
          if (outboxFile) await persist(received, outboxFile).catch(() => {});
          if (mode === 'response-lost') {
            socket.destroy();
            return;
          }
          item.acknowledged = true;
          if (outboxFile) await persist(received, outboxFile).catch(() => {});
          send(`250 OK accepted; event=${item.id}`);
        }
        dataBuffer = dataBuffer.slice(end + 5);
        dataPhase = false;
        return;
      }

      const lines = text.split('\r\n').filter(Boolean);
      for (const line of lines) {
        const command = line.slice(0, 4).toUpperCase();
        if (command === 'EHLO' || command === 'HELO') send('250-mail-simulator greets you\r\n250-8BITMIME\r\n250 OK');
        else if (command === 'MAIL') {
          if (line.match(/^MAIL FROM:\s*<transient-failure/i)) {
            send('451 temporary scheduler failure, retry later');
          } else {
            envelope.from = line;
            send('250 sender OK');
          }
        } else if (command === 'RCPT') {
          envelope.to.push(line);
          send('250 recipient OK');
        } else if (command === 'DATA') {
          dataPhase = true;
          dataBuffer = '';
          send('354 send message content');
        } else if (command === 'RSET') {
          envelope = { from: null, to: [] };
          send('250 reset');
        } else if (command === 'NOOP') send('250 OK');
        else if (command === 'QUIT') {
          send('221 bye');
          socket.end();
        } else send('502 command not implemented');
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve({
      server,
      port: server.address().port,
      async stop() {
        await new Promise((done) => server.close(done));
      },
      outbox: received,
    }));
  });
}

async function persist(received, file) {
  await fs.writeFile(file, JSON.stringify(received.map(({ raw, ...item }) => ({
    ...item,
    rawSize: raw.length,
    rawPreviewAllowed: false,
  })), null, 2));
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const instance = await startSmtpSimulator({});
  console.log(`SMTP simulator listening on ${instance.port}`);
}
