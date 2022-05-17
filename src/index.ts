import fs from "fs";
import axios from "axios";
import storage from "node-persist";

import http from 'http';
import express from 'express';
import { Request, Response, NextFunction, Express } from "express";

import { Client, TextChannel, Message, MessageOptions, MessageAttachment } from 'discord.js';
import config from './config';

enum ErrCode {
    NO_ERROR,
    PEERS_DROPPED,
    NODES_DROPPED,
    PEERS_NODES_MISSMATCH,
    VALIDATOR_SLASHED,
    NODE_UNREACHABLE,
    UNKNOWN_ERROR
}

const ErrCodeMap = new Map<ErrCode, string>([
    [ErrCode.NO_ERROR, "NO_ERROR"],
    [ErrCode.PEERS_DROPPED, "PEERS_DROPPED"],
    [ErrCode.NODES_DROPPED, "NODES_DROPPED"],
    [ErrCode.PEERS_NODES_MISSMATCH, "PEERS_NODES_MISSMATCH"],
    [ErrCode.VALIDATOR_SLASHED, "VALIDATOR_SLASHED"],
    [ErrCode.NODE_UNREACHABLE, "NODE_UNREACHABLE"],
    [ErrCode.UNKNOWN_ERROR, "UNKNOWN_ERROR"],
])


type Bond = {
    validator: string;
    stake: number
}

type CriticalError = {
    code: ErrCode;
    message: string;
    timestamp?: number;
    processed?: boolean;
}

type CriticalNotification = {
    error: CriticalError,
    reverted: boolean;
    message: Message;
}

const DISCORD_CLIENT = new Client(config.client);

let observerCheckInterval: NodeJS.Timer | undefined = undefined;
let errCodes : Array<CriticalError> = [];
const dispatchedNotifications = new Map<CriticalError, CriticalNotification>();
const logFileName = "discord_bot_error_log" + ".log";
const apiPort = 4000;

const nodeList: Array<string> = [
    "https://observer.mainnet.r-publishing.com:443",
    "https://observer2.mainnet.r-publishing.com:443",
    "https://node0.mainnet.r-publishing.com:443",
    "https://node1.mainnet.r-publishing.com:443",
    "https://node2.mainnet.r-publishing.com:443",
    "https://node3.mainnet.r-publishing.com:443",
    "https://node4.mainnet.r-publishing.com:443",
]

const pubKeyMap: Map<string, number> = new Map([
    ["0430caee36205d58885c554101885fded123f00b56bec5c9e6c1cd7c695738570080d93915718a540deed92b0b53133b45e700bd0d48322143d669a8ec854715cd", 0],
    ["04ef093ee28800cfcd8a6730e608bc477bb682d8f5480a75e3e7daab3b0a88cbe36ec69daa256e3b453b0e665292f46c9d3b6dd3ee94b481c67294c1e55f598da8", 1],
    ["04e328e037fa8dac3d06b6f95f45d33494c9ed0f164e7dccff222ab96e299395c925b1aa8f408a52e3126305f5a4aaa55570740f57447469e765d9873756c1aa28", 2],
    ["048504d953d66c20df2d1eca84aefe72d3413817cb126d92d75871a33ee373f70aab69eafbb6db2987190ed401c83f5c6e88a4d6eb46befd422b06dec24abe9afc", 3],
    ["047004babb95935e18ce482ceed9192e1842a13a91ce160c7abe40515ff2827ef5a9b353fc89132757495138314077ba95b14e37d8cfcf0f60f6032701f8e17a40", 4]
]);

const revertMessages: Array<string> = [
    "Oops, nvm, everything seems fine now!",
    "Forget that, everything is in order :)",
    "Oops, false alarm! Go back to doing nothing.",
    "Sorry, I'm not sure what happened, but everything is fine now.",
    "I'm sorry, I'm just a bot, I can't do anything about this. Anyways the network is back up.",
    "You should know better than to trust a bot, trust me.",
    "I guess I'm drunk, false alarm everyone!",
    "This is what excessive drinking does to your brain, false alarm everyone!",
    "Nvm that. Mainnet looks ok-ish, nothing to worry about... yet."
]

const probabilityMax = 10;
const probability = 2 % probabilityMax;

DISCORD_CLIENT.on('ready', async () => {
    console.log(`Logged in as ${DISCORD_CLIENT.user?.tag}!`);

    await storage.init({
        dir: 'data',
        forgiveParseErrors: true,
        logging: false,
    });

    const item = await storage.getItem("errCodes");
    if (!item) {
        await storage.setItem("errCodes", errCodes);
    } else {
        errCodes = item as Array<CriticalError>;
    }
});

const replyWithALog = async (message: Message) => {
    const attachment = new MessageAttachment(logFileName)

    await message.reply(JSON.stringify("Here's a log, figure it out yourself!", null, 2), {attachment: attachment, files: [attachment], } as MessageOptions);
}

DISCORD_CLIENT.on('message', async (message) => {
    if (message.author.bot) return;

    if (message.content.toLowerCase() === 'health') {
        const now = new Date().getTime();
        const filtered = errCodes.filter(err => err.timestamp && now - err.timestamp > 1 * 60 * 1000 * 3);
        
        await message.reply(filtered.length === 0 ? "Mainnet is healthy!" : "Mainnet is not healthy!");
    }

    if (message.content.toLowerCase() === 'reset') {
        errCodes = [];
        dispatchedNotifications.clear();
        
        errLog.close();
        try {
            fs.unlinkSync(logFileName)
            errLog = fs.createWriteStream(logFileName);
            const timestamp = new Date().toUTCString();
            const initLogMsg = timestamp + " - " + "[INFO] log initialized";
            errLog.write(initLogMsg + "\n");
        } catch(err) {
            console.error(err)
        }
        

        await storage.clear();
        await message.reply("Error codes reset");
    }

    if (message.content.toLowerCase() === 'logs' || message.content.toLowerCase() === 'log' ) {
        await replyWithALog(message);
    }

    if (message.content.toLowerCase() === 'status' ) {
        console.info("error codes:");
        console.info(errCodes);

        const randomResponse = Math.floor(Math.random() * (probabilityMax - 1 - probability + 1)) + probability;
        if (randomResponse === probability) {
            await replyWithALog(message);
        }
        else {
            await message.reply(JSON.stringify("TODO: send errCodes, for now check pm2 logs", null, 2));
        }
    }
});

var errLog = fs.createWriteStream(logFileName);

const timestamp = new Date().toUTCString();
const initLogMsg = timestamp + " - " + "[INFO] log initialized";
errLog.write(initLogMsg + "\n");


const PushMessage = async (msg: CriticalError) => {
    const found = errCodes.find( ({ code, message }) => code == msg.code && message == msg.message );
    if (!found) {

        const timestamp = new Date().toUTCString();
        const errMsg = timestamp + " - " + "[ERR] code: "  + ErrCodeMap.get(msg.code) + ", msg: " + msg.message;

        errLog.write(errMsg + "\n");
        msg.timestamp = new Date().getTime()
        errCodes.push(msg);

        await storage.updateItem("errCodes", errCodes)
    }
}

const UndoMessage = async (msg: CriticalError) => {
    const found = errCodes.find( ({ code, message }) => code == msg.code && message == msg.message );
    if (found) {
        //Opps, everything seems fine now
        const timestamp = new Date().toUTCString();
        const errMsg = timestamp + " - " + "[OK] code: "  + ErrCodeMap.get(msg.code) + " restored, prevMsg: " + msg.message;
        errLog.write(errMsg + "\n");
        errCodes = errCodes.filter( ({ code, message }) => code != found.code && message != found.message );
        await storage.updateItem("errCodes", errCodes);

        const notification = dispatchedNotifications.get(found);
        if (notification) {
            const randomMstId = Math.floor(Math.random() * (revertMessages.length - 1 - 0 + 1)) + 0;
            await notification.message.reply(revertMessages[randomMstId], {reply: notification.message} as MessageOptions);
            dispatchedNotifications.delete(notification.error);
        }
    }
}


observerCheckInterval = setInterval(async () => {
    nodeList.map((nodeUrl) => {
        const idx = nodeList.indexOf(nodeUrl);
        const errMsgUnreachable = {code: ErrCode.NODE_UNREACHABLE, message: nodeUrl + " can't be reached."}

        setTimeout(() => {
            axios.get(nodeUrl + '/api/status', {timeout: 20 * 1000, }).then(resp => {
                try {
                    UndoMessage(errMsgUnreachable);
                    const nOfPeers = resp.data.peers;
                    const nOfNodes = resp.data.nodes;
    
                    const missmatchErr = {code: ErrCode.PEERS_NODES_MISSMATCH, message: "nOfPeers !== nOfNodes on node " + nodeUrl};
                    const nOfPeersDropErr = {code: ErrCode.PEERS_DROPPED, message: "nOfPeers < 6 on node " + nodeUrl};
                    const nOfNodesDropErr = {code: ErrCode.NODES_DROPPED, message: "nOfNodes < 6 on node " + nodeUrl}
                    nOfPeers !== nOfNodes ? PushMessage(missmatchErr) : UndoMessage(missmatchErr);
                    nOfPeers < 6 ? PushMessage(nOfPeersDropErr) : UndoMessage(nOfPeersDropErr);
                    nOfNodes < 6 ? PushMessage(nOfNodesDropErr) : UndoMessage(nOfNodesDropErr);
                }
                catch (err) {
                    console.info(err);
                    PushMessage({code: ErrCode.UNKNOWN_ERROR, message: String(err)})
                }
            }).catch(err => {
                console.info(err);
                PushMessage(errMsgUnreachable);
            });
        }, 200 * idx);

        setTimeout(() => {
            axios.get(nodeUrl + '/api/blocks', {timeout: 20 * 1000}).then(resp => {
                try {
                    UndoMessage(errMsgUnreachable);
                    const blockInfo = resp.data[0];
                    const blockNr = blockInfo.blockNumber; //TODO: make sure block count is increasing
                    const bonds: Array<Bond> = blockInfo.bonds;
                    bonds.map(bond => {
                        const validatorId = pubKeyMap.get(bond.validator);
                        const message = {
                            code: ErrCode.VALIDATOR_SLASHED,
                            message: "Validator " + validatorId + " slashed"
                        }
                        if (bond.stake === 0) {
                            PushMessage(message);
                        } else {
                            UndoMessage(message);
                        }

                    });
                }
                catch (err) {
                    console.info(err);
                    PushMessage({code: ErrCode.UNKNOWN_ERROR, message: String(err)})
                }
            }).catch(err => {
                console.info(err);
                PushMessage(errMsgUnreachable);
            });
        }, 200 * nodeList.length + 200 * idx);
    })


    if (errCodes.length > 0) {
        errCodes.map(async (err) => {
            const now = new Date().getTime();
            const notificationSent = dispatchedNotifications.get(err);

            if (err.timestamp) {
                console.info(now - err.timestamp)
            }
            if (err.timestamp && now - err.timestamp > 1 * 60 * 1000 * 3 && !notificationSent) {
                //No error correction for 3 iterations, notify

                const timestamp = new Date().toUTCString();
                const errMsg = timestamp + " - " + "[INFO] sending notification...";
                errLog.write(errMsg + "\n");

                let notification = "@everyone **[MAINNET ERR]** code: " + ErrCodeMap.get(err.code) + ", msg: " + err.message + "\n";
                notification += "Please check the logs and make sure the mainnet is up, thanks! /Bot";
        
                let sent = await (DISCORD_CLIENT.channels.cache.get('970023234869276773') as TextChannel).send(notification);
                dispatchedNotifications.set(err, {error: err, reverted: false, message: sent } as CriticalNotification)
            }
        })
    }

}, 1 * 60 * 1000);


DISCORD_CLIENT.login(config.bot.token);


//API server
const routes: Express = express();
routes.use(express.json());

const getHealth = async (req: Request, res: Response, next: NextFunction) => {
    const now = new Date().getTime();
    const filtered = errCodes.filter(err => err.timestamp && now - err.timestamp > 1 * 60 * 1000 * 3);

    return res.status(200).json({
        healthy: filtered.length === 0
    });
};
routes.get('/health', getHealth);

const httpServer = http.createServer(routes);
httpServer.listen(apiPort, () => console.log(`API server is running on port ${apiPort}`));

const gracefulShutdown = async (): Promise<any> => {
    errLog.close();
    return false;
}

process.on('SIGINT', async () => {
    const err = await gracefulShutdown();
    process.exit(err ? 1 : 0);
 })