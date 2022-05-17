import { ClientOptions, Intents } from 'discord.js';

export default {
    disableEveryone: false,
    bot: {
        token: process.env.DISCORD_TOKEN,
    },
    client: {
        ws: { intents: Intents.ALL }
    } as ClientOptions
}
