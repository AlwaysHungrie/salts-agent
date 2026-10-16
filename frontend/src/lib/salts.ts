/**
 * A prompt for whatever assistant the user already has (Claude, ChatGPT, Grok, …), so
 * it can walk them through putting salts-tools on their computer, step by step.
 */
export const SALTS_SETUP_PROMPT = `I want to run "salts-tools" on this computer. It runs free web search, a resume matchmaker and a spreadsheet analyst for my Salts agent, on my own computer, and connects them to the agent over a secure tunnel. Please walk me through it one step at a time. First ask which operating system I use (macOS, Windows or Linux), then wait for me to confirm each step before the next.

What it needs:
- Node.js 20 or later, which also gives the \`npx\` command. Check with \`node --version\`.
- cloudflared, which creates the secure tunnel. No Cloudflare account is needed.
  - macOS: \`brew install cloudflared\` (install Homebrew first if I do not have it)
  - Windows: \`winget install --id Cloudflare.cloudflared\`
  - Linux: the package from Cloudflare's downloads page (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
- Only for web search: Docker. On macOS or Windows, Docker Desktop (OrbStack or Colima also work on macOS). On Linux, Docker Engine, started with \`sudo systemctl enable --now docker\`, with my user in the docker group so \`docker info\` works without sudo. I do not need to start Docker myself; salts-tools does.
- Only for the matchmaker or the spreadsheet analyst: uv (https://docs.astral.sh/uv/getting-started/installation/).

Then I run this in a terminal:

    npx salts-tools

It checks what is installed and says what is missing. It then opens my browser on a Salts page where I am already signed in, and shows a code. I check the code matches the one in my terminal and press Connect. That is the only step in the browser.

Back in the terminal, salts-tools opens a screen listing my agents. I pick an agent, switch on the tools I want for it, and do anything it lists as still to do (for example, typing in an OpenRouter key for the matchmaker). Every tool this computer can run starts on its own.

It asks whether to start when I log in; saying yes keeps my agent's tools available after a restart. My computer has to be on and online for the agent to use them.

If a command fails, ask me to paste the exact error and help me fix it. Never ask me for passwords, API keys or tokens: salts-tools never needs me to copy one.`;
