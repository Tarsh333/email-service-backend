import nodemailer from "nodemailer";

// We create ethereal test accounts on the fly and cache a transport per sender.
// Each "sender" address gets its own ethereal inbox so multi-sender works.
const transports = new Map<string, nodemailer.Transporter>();

async function getTransport(sender: string) {
  if (transports.has(sender)) return transports.get(sender)!;

  const account = await nodemailer.createTestAccount();
  const t = nodemailer.createTransport({
    host: "smtp.ethereal.email",
    port: 587,
    secure: false,
    auth: { user: account.user, pass: account.pass },
  });

  transports.set(sender, t);
  return t;
}

export async function sendEmail(opts: {
  sender: string;
  to: string;
  subject: string;
  body: string;
}) {
  const t = await getTransport(opts.sender);
  const info = await t.sendMail({
    from: opts.sender,
    to: opts.to,
    subject: opts.subject,
    text: opts.body,
  });

  return {
    messageId: info.messageId,
    previewUrl: nodemailer.getTestMessageUrl(info) || "",
  };
}
