# phone-approve

Approve Claude Code's permission prompts from your phone. When Claude Code is about to ask you whether it may run a tool, the request goes to Telegram with **✅ Approve** and **❌ Deny** buttons, and your tap decides it. Walk away from the desk and keep a long task moving.

- Only a real prompt goes to the phone. Anything your rules, mode or settings hooks already allow or deny never reaches Telegram.
- The message says what is asked: the Bash command, the file being written or edited, the URL, or the tool's input for anything else.
- If the phone doesn't answer within the timeout, the normal terminal prompt decides, and the Telegram message says so.
- If you answer in the terminal first, the plugin stops waiting and edits the message to "answered in the terminal".
- While it waits, the status line shows `📱 waiting for phone…`.

## Install

```sh
claude --plugin-dir ./phone-approve
```

or add this repo as a marketplace and install it with `/plugin`.

## Setup

1. Message [@BotFather](https://t.me/BotFather), send `/newbot`, and copy the token. **Use a dedicated bot.** The plugin reads button presses with `getUpdates`, which Telegram refuses while a bot has a webhook set, and two programs polling one bot steal each other's updates.
2. Send your new bot any message, then open `https://api.telegram.org/bot<token>/getUpdates` and copy `message.chat.id`. That's your chat id.
3. Save both (the token goes to secure storage, not settings.json):

   ```sh
   echo '{"botToken":"123456:ABC…","chatId":"987654321"}' | claude plugin configure phone-approve --values-stdin
   ```

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `botToken` | (none) | The bot's token. Marked sensitive, so it's kept in secure storage and never logged. |
| `chatId` | (none) | Where requests go. Presses from any other chat are ignored. |
| `timeoutSeconds` | `120` | How long to wait for the phone before the terminal prompt decides. |

The plugin does nothing until `botToken` and `chatId` are set.

## How it works

It hooks `classic.PermissionRequest`, which Claude Code raises when it is about to ask you. It sends the request with `$.http.fetch`, then long-polls `getUpdates` for the button press carrying that request's one-time nonce. If nothing comes back in time, it returns `next(e)` so the terminal prompt decides.
