export type EmailTemplate = {
  id: string;
  name: string;
  category: "Newsletter" | "Promotion" | "Lifecycle";
  description: string;
  subject: string;
  previewText: string;
  textBody: string;
  layout: "newsletter" | "announcement" | "showcase" | "welcome" | "two-column" | "three-column" | "gallery" | "simple";
  html: string;
};

export type EmailBrand = { businessName?: string; fromName?: string; physicalAddress?: string; sendingDomain?: string };

const firstName = "{{{contact.first_name|there}}}";
const unsubscribe = "{{{RESEND_UNSUBSCRIBE_URL}}}";
export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char] || char);
// Sending domains are usually a mail subdomain (news.example.com); link to the root site instead.
const websiteFor = (sendingDomain = "") => { const host = sendingDomain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^(mail|email|news|newsletter|send|mg|em|updates|marketing)\./, ""); return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(host) ? `https://${host}` : ""; };
const button = (label: string, href: string) => href ? `<table role="presentation" cellspacing="0" cellpadding="0"><tr><td style="border-radius:8px;background:#3968ff"><a href="${escapeHtml(href)}" style="display:inline-block;padding:13px 22px;color:#ffffff;font:700 14px Arial,sans-serif;text-decoration:none">${label}</a></td></tr></table>` : "";
const imageBlock = (label: string, height = 220) => `<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td height="${height}" align="center" style="height:${height}px;background:#e7ecf6;color:#71809b;font:700 13px Arial,sans-serif;letter-spacing:.08em;text-transform:uppercase">${label}</td></tr></table>`;

export function buildEmailTemplates(brand: EmailBrand = {}): EmailTemplate[] {
  const name = (brand.businessName || brand.fromName || "").trim(), sender = (brand.fromName || "").trim(), website = websiteFor(brand.sendingDomain);
  const address = (brand.physicalAddress || "").trim().split(/\s*\n\s*/).filter(Boolean).join(", ");
  const initials = name.split(/\s+/).map(word => word.match(/[a-z0-9]/i)?.[0] || "").join("").slice(0, 2).toUpperCase() || "Hi";
  const footer = [name, address].filter(Boolean).map(escapeHtml).join(" · ");
  const visit = (label: string) => website ? `\n\n${label}: ${website}` : "";
  const cta = (label: string) => button(label, website);
  const shell = (content: string, accent = "#3968ff") => `<!doctype html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"><style>@media only screen and (max-width:620px){.email-shell{width:100%!important}.stack{display:block!important;width:100%!important}.mobile-pad{padding-left:24px!important;padding-right:24px!important}}</style></head>
<body style="margin:0;padding:0;background:#f2f4f8;color:#172033;font-family:Arial,sans-serif">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f2f4f8"><tr><td align="center" style="padding:32px 12px">
<table role="presentation" width="600" class="email-shell" cellspacing="0" cellpadding="0" style="width:600px;max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden">
<tr><td class="mobile-pad" style="padding:22px 36px;border-top:5px solid ${accent}"><table role="presentation" width="100%"><tr><td style="font:800 16px Arial,sans-serif;color:#111b31">${escapeHtml(name.toUpperCase())}</td><td align="right" style="font:12px Arial,sans-serif;color:#667085">Customer update</td></tr></table></td></tr>
${content}
<tr><td class="mobile-pad" style="padding:28px 36px;background:#111b31;color:#aeb8cc;text-align:center;font:12px/1.7 Arial,sans-serif">${footer ? `${footer}<br>` : ""}<a href="${unsubscribe}" style="color:#ffffff;text-decoration:underline">Unsubscribe</a> from marketing emails</td></tr>
</table></td></tr></table></body></html>`;

  return [
    {
      id: "newsletter",
      name: "Customer newsletter",
      category: "Newsletter",
      description: "A lead story followed by two short updates.",
      subject: name ? `What’s new at ${name}` : "What’s new",
      previewText: "A quick roundup of what we’ve been working on.",
      layout: "newsletter",
      textBody: `Hello ${firstName},\n\nHere is this month’s customer update.\n\nFEATURED STORY\nShare your most important update here.\n\nIN BRIEF\nAdd two shorter stories or useful links.${visit("Visit")}\n\nUnsubscribe: ${unsubscribe}`,
      html: shell(`<tr><td class="mobile-pad" style="padding:42px 36px 26px"><div style="color:#3968ff;font:700 12px Arial,sans-serif;letter-spacing:.12em;text-transform:uppercase">Monthly briefing</div><h1 style="margin:12px 0 14px;font:800 34px/1.12 Arial,sans-serif;color:#111b31">Hello ${firstName}, here’s what’s new.</h1><p style="margin:0;color:#526079;font:16px/1.7 Arial,sans-serif">A concise customer update with one central story and two useful takeaways.</p></td></tr><tr><td>${imageBlock("Featured image", 240)}</td></tr><tr><td class="mobile-pad" style="padding:30px 36px"><h2 style="margin:0 0 10px;font:700 23px Arial,sans-serif">Your featured story</h2><p style="margin:0 0 22px;color:#526079;font:15px/1.7 Arial,sans-serif">Explain the most important news, insight, or customer success story in a few clear sentences.</p>${cta("Read the full story")}</td></tr><tr><td class="mobile-pad" style="padding:4px 36px 34px"><table role="presentation" width="100%"><tr><td class="stack" width="48%" valign="top" style="padding:20px;background:#f5f7fb"><b style="font:700 16px Arial,sans-serif">First quick update</b><p style="color:#667085;font:14px/1.6 Arial,sans-serif">Add a short supporting story or resource.</p></td><td class="stack" width="4%"></td><td class="stack" width="48%" valign="top" style="padding:20px;background:#f5f7fb"><b style="font:700 16px Arial,sans-serif">Second quick update</b><p style="color:#667085;font:14px/1.6 Arial,sans-serif">Share another useful announcement or link.</p></td></tr></table></td></tr>`),
    },
    {
      id: "announcement",
      name: "Make an announcement",
      category: "Newsletter",
      description: "A focused message for important news.",
      subject: name ? `An important update from ${name}` : "An important update",
      previewText: "We have something new to share with you.",
      layout: "announcement",
      textBody: `Hello ${firstName},\n\nWe have an important update to share.\n\nAdd the announcement details and next steps here.${visit("Learn more")}\n\nUnsubscribe: ${unsubscribe}`,
      html: shell(`<tr><td class="mobile-pad" align="center" style="padding:54px 36px 30px"><div style="color:#3968ff;font:700 12px Arial,sans-serif;letter-spacing:.12em;text-transform:uppercase">Big news</div><h1 style="max-width:480px;margin:14px auto;font:800 38px/1.1 Arial,sans-serif;color:#111b31">We have something exciting to share.</h1><p style="max-width:470px;margin:0 auto;color:#526079;font:16px/1.7 Arial,sans-serif">Hello ${firstName}. Put the announcement in plain language, explain why it matters, and give readers one clear next step.</p></td></tr><tr><td style="padding:0 36px">${imageBlock("Announcement image", 260)}</td></tr><tr><td align="center" class="mobile-pad" style="padding:28px 36px 42px">${cta("Learn more")}</td></tr>`, "#f0a43c"),
    },
    {
      id: "showcase",
      name: "Project showcase",
      category: "Promotion",
      description: "Feature one project, service, or success story.",
      subject: "A closer look at our latest work",
      previewText: "See the idea, process, and outcome.",
      layout: "showcase",
      textBody: `Hello ${firstName},\n\nTake a closer look at our latest project.\n\nTHE CHALLENGE\nDescribe the starting point.\n\nTHE RESULT\nExplain what changed and why it matters.${visit("View the project")}\n\nUnsubscribe: ${unsubscribe}`,
      html: shell(`<tr><td>${imageBlock("Project hero image", 300)}</td></tr><tr><td class="mobile-pad" style="padding:38px 36px"><div style="color:#3968ff;font:700 12px Arial,sans-serif;letter-spacing:.12em;text-transform:uppercase">Featured work</div><h1 style="margin:12px 0 16px;font:800 34px/1.15 Arial,sans-serif;color:#111b31">A project worth a closer look</h1><p style="margin:0 0 26px;color:#526079;font:16px/1.7 Arial,sans-serif">Hello ${firstName}. Describe the creative challenge, your approach, and the result in a story that is easy to scan.</p><table role="presentation" width="100%"><tr><td class="stack" width="48%" valign="top"><b>THE CHALLENGE</b><p style="color:#667085;font:14px/1.6 Arial,sans-serif">What needed to change?</p></td><td class="stack" width="4%"></td><td class="stack" width="48%" valign="top"><b>THE RESULT</b><p style="color:#667085;font:14px/1.6 Arial,sans-serif">What did the work achieve?</p></td></tr></table><div style="height:18px"></div>${cta("View the project")}</td></tr>`, "#7457d9"),
    },
    {
      id: "welcome",
      name: "Welcome",
      category: "Lifecycle",
      description: "A warm introduction for new subscribers.",
      subject: name ? `Welcome to ${name}` : "Welcome",
      previewText: "Here’s what you can expect from us.",
      layout: "welcome",
      textBody: `Welcome, ${firstName}!\n\nThanks for joining us. We’ll send practical ideas, studio updates, and occasional project stories.${visit("Explore our work")}\n\nUnsubscribe: ${unsubscribe}`,
      html: shell(`<tr><td class="mobile-pad" align="center" style="padding:58px 36px 26px"><div style="width:64px;height:64px;line-height:64px;border-radius:50%;background:#e8edff;color:#3968ff;font:800 24px Arial,sans-serif">${escapeHtml(initials)}</div><h1 style="margin:22px 0 14px;font:800 36px/1.12 Arial,sans-serif;color:#111b31">Welcome, ${firstName}.</h1><p style="max-width:470px;margin:0 auto;color:#526079;font:16px/1.7 Arial,sans-serif">Thanks for joining us. We’ll send useful ideas, thoughtful studio updates, and occasional stories from our work.</p></td></tr><tr><td class="mobile-pad" style="padding:8px 36px 38px"><table role="presentation" width="100%"><tr><td style="padding:22px;background:#f5f7fb;border-radius:10px"><b>What to expect</b><p style="margin:8px 0 0;color:#667085;font:14px/1.7 Arial,sans-serif">Practical insights · Selected projects · Studio news</p></td></tr></table><div style="height:24px"></div>${cta("Explore our work")}</td></tr>`, "#33a27b"),
    },
    {
      id: "two-column",
      name: "Two-column update",
      category: "Newsletter",
      description: "Two equal stories with separate calls to action.",
      subject: "Two ideas worth sharing",
      previewText: "Two quick stories, one useful update.",
      layout: "two-column",
      textBody: `Hello ${firstName},\n\nSTORY ONE\nAdd your first story and link.\n\nSTORY TWO\nAdd your second story and link.\n\nUnsubscribe: ${unsubscribe}`,
      html: shell(`<tr><td class="mobile-pad" style="padding:42px 36px 28px"><h1 style="margin:0 0 12px;font:800 34px/1.15 Arial,sans-serif;color:#111b31">Two ideas for ${firstName}</h1><p style="margin:0;color:#526079;font:16px/1.7 Arial,sans-serif">Use this balanced layout when two stories deserve equal attention.</p></td></tr><tr><td class="mobile-pad" style="padding:0 36px 42px"><table role="presentation" width="100%"><tr><td class="stack" width="48%" valign="top">${imageBlock("Image one", 170)}<h2 style="font:700 20px Arial,sans-serif">First story</h2><p style="color:#667085;font:14px/1.65 Arial,sans-serif">A short description that makes the reader want to learn more.</p>${cta("Read more")}</td><td class="stack" width="4%"></td><td class="stack" width="48%" valign="top">${imageBlock("Image two", 170)}<h2 style="font:700 20px Arial,sans-serif">Second story</h2><p style="color:#667085;font:14px/1.65 Arial,sans-serif">A second concise description with a focused next step.</p>${cta("Read more")}</td></tr></table></td></tr>`),
    },
    {
      id: "three-column",
      name: "Three-column roundup",
      category: "Newsletter",
      description: "A compact trio of services, updates, or links.",
      subject: "Three things to know this month",
      previewText: "A compact roundup from the studio.",
      layout: "three-column",
      textBody: `Hello ${firstName},\n\nHere are three quick updates.\n\n1. First update\n2. Second update\n3. Third update\n\nUnsubscribe: ${unsubscribe}`,
      html: shell(`<tr><td class="mobile-pad" align="center" style="padding:44px 36px 28px"><h1 style="margin:0 0 12px;font:800 32px/1.15 Arial,sans-serif;color:#111b31">Three things to know</h1><p style="margin:0;color:#526079;font:16px/1.7 Arial,sans-serif">A quick, scannable roundup for ${firstName}.</p></td></tr><tr><td class="mobile-pad" style="padding:0 36px 42px"><table role="presentation" width="100%"><tr>${["First update","Second update","Third update"].map((title,index)=>`<td class="stack" width="33.33%" valign="top" style="padding:${index===0?"20px 14px 20px 0":index===2?"20px 0 20px 14px":"20px 14px"};border-top:3px solid #3968ff"><b style="font:700 16px Arial,sans-serif">${title}</b><p style="color:#667085;font:13px/1.6 Arial,sans-serif">Add a brief description and a useful link.</p>${website ? `<a href="${website}" style="color:#3968ff;font:700 13px Arial,sans-serif">Explore →</a>` : ""}</td>`).join("")}</tr></table></td></tr>`),
    },
    {
      id: "gallery",
      name: "Visual gallery",
      category: "Promotion",
      description: "A visual-first grid for several examples.",
      subject: "A few things we’ve been creating",
      previewText: "A visual tour of recent work.",
      layout: "gallery",
      textBody: `Hello ${firstName},\n\nHere are a few recent projects from the studio.${visit("View the full gallery")}\n\nUnsubscribe: ${unsubscribe}`,
      html: shell(`<tr><td class="mobile-pad" align="center" style="padding:42px 36px 26px"><h1 style="margin:0 0 12px;font:800 34px/1.15 Arial,sans-serif;color:#111b31">A few things we’ve been creating</h1><p style="margin:0;color:#526079;font:16px/1.7 Arial,sans-serif">A visual tour for ${firstName}.</p></td></tr><tr><td class="mobile-pad" style="padding:0 36px"><table role="presentation" width="100%"><tr><td class="stack" width="49%">${imageBlock("Gallery image 1", 190)}</td><td width="2%"></td><td class="stack" width="49%">${imageBlock("Gallery image 2", 190)}</td></tr><tr><td colspan="3" height="12"></td></tr><tr><td class="stack" width="49%">${imageBlock("Gallery image 3", 190)}</td><td width="2%"></td><td class="stack" width="49%">${imageBlock("Gallery image 4", 190)}</td></tr></table></td></tr><tr><td align="center" class="mobile-pad" style="padding:28px 36px 42px">${cta("View the full gallery")}</td></tr>`, "#d2568c"),
    },
    {
      id: "simple",
      name: "Simple personal note",
      category: "Lifecycle",
      description: "A clean, personal-looking message.",
      subject: sender ? `A quick note from ${sender}` : "A quick note",
      previewText: "A short personal update.",
      layout: "simple",
      textBody: `Hi ${firstName},\n\nI wanted to share a quick update with you. Replace this text with your message and keep it concise and conversational.\n\n${["Best,", sender, name !== sender ? name : ""].filter(Boolean).join("\n")}\n\nUnsubscribe: ${unsubscribe}`,
      html: shell(`<tr><td class="mobile-pad" style="padding:48px 54px 52px"><p style="margin:0 0 20px;font:16px/1.75 Arial,sans-serif;color:#27344c">Hi ${firstName},</p><p style="margin:0 0 20px;font:16px/1.75 Arial,sans-serif;color:#27344c">I wanted to share a quick update with you. Replace this text with your message and keep it concise, useful, and conversational.</p><p style="margin:0 0 24px;font:16px/1.75 Arial,sans-serif;color:#27344c">Add another short paragraph or a single call to action if needed.</p><p style="margin:0;font:16px/1.75 Arial,sans-serif;color:#27344c">Best,${sender ? `<br><b>${escapeHtml(sender)}</b>` : ""}${name && name !== sender ? `<br>${escapeHtml(name)}` : ""}</p></td></tr>`),
    },
  ];
}
