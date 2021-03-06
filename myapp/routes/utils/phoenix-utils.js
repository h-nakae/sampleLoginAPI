//import { Socket } from "phoenix";
const Socket = require('phoenix');
//import { generateHubName } from "../utils/name-generation";
//import configs from "./configs";
const configs = require('./configs');

//import Store from "../storage/store";

export function hasReticulumServer() {
  return !!configs.RETICULUM_SERVER;
}

export function isLocalClient() {
  return hasReticulumServer() && document.location.host !== configs.RETICULUM_SERVER;
}

export function hubUrl(hubId) {
  if (!hubId) {
    if (isLocalClient()) {
      hubId = new URLSearchParams(location.search).get("hub_id");
    } else {
      hubId = location.pathname.split("/")[1];
    }
  }
  return new URL(isLocalClient() ? `/hub.html?hub_id=${hubId}` : `/${hubId}`, location.href);
}

const resolverLink = document.createElement("a");
let reticulumMeta = null;
let invalidatedReticulumMetaThisSession = false;

export function getReticulumFetchUrl(path, absolute = false, host = null, port = null) {
  if (host || hasReticulumServer()) {
    return `https://${host || configs.RETICULUM_SERVER}${port ? `:${port}` : ""}${path}`;
  } else if (absolute) {
    resolverLink.href = path;
    return resolverLink.href;
  } else {
    return path;
  }
}

export async function getReticulumMeta() {
  if (!reticulumMeta) {
    // Initially look up version based upon page, avoiding round-trip, otherwise fetch.
    if (!invalidatedReticulumMetaThisSession && document.querySelector("meta[name='ret:version']")) {
      reticulumMeta = {
        version: document.querySelector("meta[name='ret:version']").getAttribute("value"),
        pool: document.querySelector("meta[name='ret:pool']").getAttribute("value"),
        phx_host: document.querySelector("meta[name='ret:phx_host']").getAttribute("value")
      };
    } else {
      await fetch(getReticulumFetchUrl("/api/v1/meta")).then(async res => {
        reticulumMeta = await res.json();
      });
    }
  }

  const qs = new URLSearchParams(location.search);
  const phxHostOverride = qs.get("phx_host");

  if (phxHostOverride) {
    reticulumMeta.phx_host = phxHostOverride;
  }

  return reticulumMeta;
}

let directReticulumHostAndPort;

async function refreshDirectReticulumHostAndPort() {
  const qs = new URLSearchParams(location.search);
  let host = qs.get("phx_host");
  const reticulumMeta = await getReticulumMeta();
  host = host || configs.RETICULUM_SOCKET_SERVER || reticulumMeta.phx_host;
  const port =
    qs.get("phx_port") ||
    (hasReticulumServer() ? new URL(`${document.location.protocol}//${configs.RETICULUM_SERVER}`).port : "443");
  directReticulumHostAndPort = { host, port };
}

export function getDirectReticulumFetchUrl(path, absolute = false) {
  if (!directReticulumHostAndPort) {
    console.warn("Cannot call getDirectReticulumFetchUrl before connectToReticulum. Returning non-direct url.");
    return getReticulumFetchUrl(path, absolute);
  }

  const { host, port } = directReticulumHostAndPort;
  return getReticulumFetchUrl(path, absolute, host, port);
}

export async function invalidateReticulumMeta() {
  invalidatedReticulumMetaThisSession = true;
  reticulumMeta = null;
}

export async function connectToReticulum(debug = false, params = null, socketClass = Socket) {
  const qs = new URLSearchParams(location.search);

  const getNewSocketUrl = async () => {
    await refreshDirectReticulumHostAndPort();
    const { host, port } = directReticulumHostAndPort;
    const protocol =
      qs.get("phx_protocol") ||
      configs.RETICULUM_SOCKET_PROTOCOL ||
      (document.location.protocol === "https:" ? "wss:" : "ws:");

    return `${protocol}//${host}${port ? `:${port}` : ""}`;
  };

  const socketUrl = await getNewSocketUrl();
  console.log(`Phoenix Socket URL: ${socketUrl}`);

  const socketSettings = {};

  if (debug) {
    socketSettings.logger = (kind, msg, data) => {
      console.log(`${kind}: ${msg}`, data);
    };
  }

  if (params) {
    socketSettings.params = params;
  }

  const socket = new socketClass(`${socketUrl}/socket`, socketSettings);
  socket.connect();
  socket.onError(async () => {
    // On error, underlying reticulum node may have died, so rebalance by
    // fetching a new healthy node to connect to.
    invalidateReticulumMeta();

    const endPointPath = new URL(socket.endPoint).pathname;
    const newSocketUrl = await getNewSocketUrl();
    const newEndPoint = `${newSocketUrl}${endPointPath}`;
    console.log(`Socket error, changed endpoint to ${newEndPoint}`);
    socket.endPoint = newEndPoint;
  });

  return socket;
}


// Takes the given channel, and creates a new channel with the same bindings
// with the given socket, joins it, and leaves the old channel after joining.
//
// NOTE: This function relies upon phoenix channel object internals, so this
// function will need to be reviewed if/when we ever update phoenix.js
export function migrateChannelToSocket(oldChannel, socket, params) {
  const channel = socket.channel(oldChannel.topic, params || oldChannel.params);

  for (let i = 0, l = oldChannel.bindings.length; i < l; i++) {
    const item = oldChannel.bindings[i];
    channel.on(item.event, item.callback);
  }

  for (let i = 0, l = oldChannel.pushBuffer.length; i < l; i++) {
    const item = oldChannel.pushBuffer[i];
    channel.push(item.event, item.payload, item.timeout);
  }

  const oldJoinPush = oldChannel.joinPush;
  const joinPush = channel.join();

  for (let i = 0, l = oldJoinPush.recHooks.length; i < l; i++) {
    const item = oldJoinPush.recHooks[i];
    joinPush.receive(item.status, item.callback);
  }

  return new Promise(resolve => {
    joinPush.receive("ok", () => {
      // Clear all event handlers first so no duplicate messages come in.
      oldChannel.bindings = [];
      resolve(channel);
    });
  });
}


