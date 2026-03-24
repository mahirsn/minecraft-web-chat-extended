// @ts-check
'use strict';

import { querySelectorWithAssertion, formatTimestamp } from './utils.mjs';
import {
    assertIsComponent,
    ComponentError,
    formatMessage,
    initializeObfuscation,
} from './messages/message_parsing.mjs';
import { serverInfo } from './managers/server_info.mjs';
import { playerList, toggleSidebar } from './managers/player_list.mjs';
import { directMessageManager } from './managers/direct_message.mjs';
import { parseModServerMessage } from './messages/message_types.mjs';
import { faviconManager } from './managers/favicon_manager.mjs';
import { tabListManager } from './managers/tab_list_manager.mjs';

/**
 * Import all types we might need
 * @typedef {import('./messages/message_parsing.mjs').Component} Component
 * @typedef {import('./messages/message_types.mjs').ChatMessage} ChatMessage
 * @typedef {import('./messages/message_types.mjs').HistoryMetaData} HistoryMetaData
 * @typedef {import('./messages/message_types.mjs').PlayerInfo} PlayerInfo
 * @typedef {import('./messages/message_types.mjs').ServerConnectionState} ServerConnectionState
 */

/**
 * ======================
 *  Constants & Globals
 * ======================
 */

/** @type {string | null} */
let modVersion = null;

// WebSocket Management
/** @type {number} */
const maxReconnectAttempts = 300; // TODO: add a reconnect button after automatic retries are done.
/** @type {WebSocket | null} */
let ws = null;
/** @type {number} */
let reconnectAttempts = 0;

// Message History Management
const messageHistoryLimit = 50;
let isLoadingHistory = false;

// Used to keep track of messages already shown. To prevent possible duplication on server join.
/** @type {Set<string>} */
const displayedMessageIds = new Set();

/**
 * ======================
 *  HTML elements
 * ======================
 */

const statusElement = /** @type {HTMLDivElement} */ (
    querySelectorWithAssertion('#status')
);
const sidebarToggleElement = /** @type {HTMLImageElement} */ (
    querySelectorWithAssertion('#sidebar-toggle')
);

const messagesElement = /** @type {HTMLElement} */ (
    querySelectorWithAssertion('#messages')
);
const historyLoaderElement = /** @type {HTMLDivElement} */ (
    querySelectorWithAssertion('#history-loader')
);

const skipToPresentButton = /** @type {HTMLButtonElement} */ (
    querySelectorWithAssertion('#skip-to-present')
);

const inputAlertElement = /** @type {HTMLDivElement} */ (
    querySelectorWithAssertion('#input-alert')
);

const clearRecipientElement = /** @type {HTMLImageElement} */ (
    querySelectorWithAssertion('#direct-message-clear')
);

const chatInputElement = /** @type {HTMLTextAreaElement} */ (
    querySelectorWithAssertion('#message-input')
);

const messageSendButtonElement = /** @type {HTMLImageElement} */ (
    querySelectorWithAssertion('#message-send-button')
);

const modModalContainer = /** @type {HTMLDivElement} */ (
    querySelectorWithAssertion('#mod-modal-container')
);
const modModalTitle = /** @type {HTMLHeadingElement} */ (
    querySelectorWithAssertion('#mod-modal-title')
);
const modModalDuration = /** @type {HTMLInputElement} */ (
    querySelectorWithAssertion('#mod-modal-duration')
);
const modModalReason = /** @type {HTMLInputElement} */ (
    querySelectorWithAssertion('#mod-modal-reason')
);
const modModalSubmit = /** @type {HTMLButtonElement} */ (
    querySelectorWithAssertion('#mod-modal-submit')
);
const modModalCancel = /** @type {HTMLButtonElement} */ (
    querySelectorWithAssertion('#mod-modal-cancel')
);

/**
 * ======================
 *  Event listeners and handlers
 * ======================
 */

sidebarToggleElement.addEventListener('click', () => {
    toggleSidebar();
});

clearRecipientElement.addEventListener('click', () => {
    directMessageManager.clearPlayer();
});

// Clicked send button
messageSendButtonElement.addEventListener('click', () => {
    sendChatMessage();
});

/** @type {string | null} */
let currentModAction = null;
/** @type {string | null} */
let currentModTarget = null;

/**
 * @param {string} action
 * @param {string} username
 */
function openModModal(action, username) {
    currentModAction = action;
    currentModTarget = username;
    modModalTitle.textContent = `${action.charAt(0).toUpperCase() + action.slice(1)} ${username}`;
    
    if (action === 'kick') {
        modModalDuration.style.display = 'none';
        modModalDuration.value = '';
    } else {
        modModalDuration.style.display = 'block';
        modModalDuration.value = '';
    }
    modModalReason.value = '';
    modModalContainer.style.display = 'block';
    modModalContainer.setAttribute('aria-hidden', 'false');
    if (action !== 'kick') {
        modModalDuration.focus();
    } else {
        modModalReason.focus();
    }
}

function closeModModal() {
    modModalContainer.style.display = 'none';
    modModalContainer.setAttribute('aria-hidden', 'true');
    currentModAction = null;
    currentModTarget = null;
}

modModalCancel.addEventListener('click', closeModModal);

modModalSubmit.addEventListener('click', () => {
    if (!currentModAction || !currentModTarget) return;
    
    const duration = modModalDuration.value.trim();
    const reason = modModalReason.value.trim();
    
    let cmd = `/${currentModAction} ${currentModTarget}`;
    if (currentModAction !== 'kick' && duration) {
        cmd += ` ${duration}`;
    }
    if (reason) {
        cmd += ` ${reason}`;
    }
    
    sendWebsocketMessage('chat', cmd);
    closeModModal();
});

// Focus input on load
chatInputElement.focus();

chatInputElement.addEventListener('keydown', function (e) {
    setChatInputError(false);

    if (tabListManager.visible()) {
        tabListManager.handleInputKeydown(e);
        return;
    }

    switch (e.key) {
        case 'Escape':
            chatInputElement.blur();
            return;
        case 'Tab':
            e.preventDefault();
            tabListManager.openTabList(playerList.getAllPlayers());
            return;
        case 'Enter':
            e.preventDefault();
            sendChatMessage();
            return;
    }
});

chatInputElement.addEventListener('input', function () {
    tabListManager.hide();
    setChatInputError(false);
});

// Hide tablist when textarea loses focus
chatInputElement.addEventListener('blur', function () {
    tabListManager.hide();
});

// Scroll-based history loading
/** @type {number | null} */
let scrollDebounceTimer = null;
messagesElement.addEventListener('scroll', () => {
    skipToPresentButton.style.display =
        messagesElement.scrollTop < -200 ? 'block' : 'none';

    if (scrollDebounceTimer) {
        clearTimeout(scrollDebounceTimer);
    }

    scrollDebounceTimer = setTimeout(() => {
        checkScrollAndLoadHistory();
    }, 100);
});

skipToPresentButton.addEventListener('click', () => {
    messagesElement.scrollTop = 0;
});

/**
 * Check if the user has scrolled near the top and load more history if needed
 */
function checkScrollAndLoadHistory() {
    if (isLoadingHistory) {
        return;
    }

    // Check if there's more history to load
    const maybeTimestamp = Number(
        historyLoaderElement.dataset['oldestMessageTimestamp'] ?? '',
    );
    if (!isFinite(maybeTimestamp)) {
        return;
    }

    const scrollThreshold = 300; // pixels from top to trigger load
    const maxScroll =
        messagesElement.scrollHeight - messagesElement.clientHeight;
    const currentScrollFromTop = maxScroll + messagesElement.scrollTop;

    if (currentScrollFromTop <= scrollThreshold) {
        requestHistory(messageHistoryLimit, maybeTimestamp);
    }
}

/**
 * ======================
 *  Chat related functions
 * ======================
 */

/**
 * Request chat history from the server
 * @param {number} limit
 * @param {number} [before]
 */
function requestHistory(limit, before) {
    if (isLoadingHistory) {
        console.log('Already loading history, skipping request.');
        return;
    }

    // Probably disconnected, do nothing.
    const serverId = serverInfo.getId();
    if (!serverId) {
        return;
    }

    isLoadingHistory = true;
    historyLoaderElement.style.display = 'flex';

    sendWebsocketMessage('history', {
        serverId,
        limit,
        before,
    });
}

/**
 * Handle minecraft chat messages
 * @param {ChatMessage} message
 */
function handleChatMessage(message) {
    // Skip if we've already seen this message
    if (displayedMessageIds.has(message.payload.uuid)) {
        return;
    }

    displayedMessageIds.add(message.payload.uuid);

    if (!message.payload.history) {
        faviconManager.handleNewMessage(message.payload.isPing);
    }

    requestAnimationFrame(() => {
        const messageElement = document.createElement('article');
        messageElement.classList.add('message');

        if (message.payload.isPing) {
            messageElement.classList.add('ping');
        }

        // Create timestamp outside of try block. That way errors can be timestamped as well for the moment they did happen.
        const { timeString, fullDateTime } = formatTimestamp(message.timestamp);
        const timeElement = document.createElement('time');
        timeElement.dateTime = new Date(message.timestamp).toISOString();
        timeElement.textContent = timeString;
        timeElement.title = fullDateTime;
        timeElement.className = 'message-time';
        messageElement.appendChild(timeElement);

        let chatContentText = '';
        try {
            // Format the chat message - this uses the Component format from message_parsing
            assertIsComponent(message.payload.component);
            const chatContent = formatMessage(
                message.payload.component,
                message.payload.translations,
            );
            if (chatContent.textContent?.startsWith('Web chat: http://')) {
                // Ignore web chat links.
                return;
            }

            chatContentText = chatContent.textContent || '';

            messageElement.appendChild(chatContent);
        } catch (e) {
            console.error(message);
            if (e instanceof ComponentError) {
                console.error('Invalid component:', e.toString());
                messageElement.appendChild(
                    formatMessage(
                        {
                            text: 'Invalid message received from server',
                            color: 'red',
                        },
                        {},
                    ),
                );
            } else {
                console.error('Error parsing message:', e);
                messageElement.appendChild(
                    formatMessage(
                        {
                            text: 'Error parsing message',
                            color: 'red',
                        },
                        {},
                    ),
                );
            }
        }

        const rawText = chatContentText || '';
        const prefixMatch = rawText.match(/^[^:>»]*/);
        const rawUsername = prefixMatch ? prefixMatch[0] : rawText;
        const pureUsername = rawUsername.replace(/[^a-zA-Z0-9_]/g, '');

        if (pureUsername) {
            const modActions = document.createElement('div');
            modActions.className = 'mod-actions';
            modActions.innerHTML = `
                <button class="mod-btn ban-btn" title="Ban">
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M14.05 3.03l 6.92 6.92c.63.63.63 1.65 0 2.27l-2.12 2.12c-.63.63-1.65.63-2.27 0l-1.41-1.41L7.54 20.55c-.2.2-.5.2-.71 0l-2.12-2.12c-.2-.2-.2-.5 0-.71L12.33 10.1l-1.41-1.41c-.63-.63-.63-1.65 0-2.27l2.12-2.12c.63-.63 1.65-.63 2.27 0l.74.73zM5.31 16.59l-.71-.71c-.78-.78-2.05-.78-2.83 0l-1.06 1.06c-.78.78-.78 2.05 0 2.83l.71.71c.78.78 2.05.78 2.83 0l1.06-1.06c.78-.78.78-2.05 0-2.83z"/></svg>
                </button>
                <button class="mod-btn mute-btn" title="Mute">
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02 3.28c-.91.78-2.1 1.22-3.48 1.22-2.76 0-5-2.24-5-5H4.8c0 3.53 2.61 6.43 6 6.92V21h2.4v-3.58c1.36-.2 2.61-.79 3.63-1.64l-1.85-1.5zM12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v4.5l3 3v1.5zM2.1 3.51L.69 4.93 6.64 10.88c-.09.35-.14.72-.14 1.12v2h1.7v-2c0-.18.02-.36.05-.53l4 4V19c0 .55.45 1 1 1s1-.45 1-1v-2.31l6.73 6.73 1.41-1.41L2.1 3.51z"/></svg>
                </button>
                <button class="mod-btn kick-btn" title="Kick">
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zM3.86 12c0-4.49 3.65-8.14 8.14-8.14 1.83 0 3.53.61 4.9 1.63L5.49 16.9c-1.02-1.37-1.63-3.07-1.63-4.9zM12 20.14c-1.83 0-3.53-.61-4.9-1.63l11.41-11.41c1.02 1.37 1.63 3.07 1.63 4.9 0 4.49-3.65 8.14-8.14 8.14z"/></svg>
                </button>
            `;
            modActions.querySelectorAll('.mod-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const mouseEvent = /** @type {MouseEvent} */ (e);
                    mouseEvent.stopPropagation();
                    let action = 'kick';
                    if (btn.classList.contains('ban-btn')) action = 'ban';
                    if (btn.classList.contains('mute-btn')) action = 'mute';

                    if (mouseEvent.shiftKey) {
                        if (action === 'ban') sendWebsocketMessage('chat', `/ban ${pureUsername} 10d`);
                        else if (action === 'mute') sendWebsocketMessage('chat', `/mute ${pureUsername} 24h`);
                        else if (action === 'kick') sendWebsocketMessage('chat', `/kick ${pureUsername}`);
                    } else {
                        openModModal(action, pureUsername);
                    }
                });
            });
            messageElement.appendChild(modActions);
        }

        // Storing raw scroll value. To be used to fix the scroll position down the line.
        const scrolledFromTop = messagesElement.scrollTop;

        if (message.payload.history) {
            // Insert the message before the history loader
            historyLoaderElement.before(messageElement);
        } else {
            // For new messages, insert at the start
            messagesElement.insertBefore(
                messageElement,
                messagesElement.firstChild,
            );
        }

        // If it is due to the flex column reverse or something else, once the user has scrolled it doesn't "lock" at the bottom.
        // Let's fix that, if the user was near the bottom when a message was inserted we put them back there.
        // Note: the values appear negative due to the flex column shenanigans.
        if (scrolledFromTop <= 1 && scrolledFromTop >= -35) {
            messagesElement.scrollTop = 0;
        }
    });
}

function clearMessageHistory() {
    console.log('clearing history.');
    // empty previously seen messages.
    displayedMessageIds.clear();
    // Reset the history loader
    historyLoaderElement.style.display = 'none';
    historyLoaderElement.dataset['oldestMessageTimestamp'] = '';

    // Only remove messages, leaving the history loader alone.
    const messageElements = messagesElement.querySelectorAll('.message');
    messageElements.forEach((element) => {
        element.remove();
    });
}

/**
 * Handle history meta data
 * @param {HistoryMetaData} message
 */
function handleHistoryMetaData(message) {
    isLoadingHistory = false;
    historyLoaderElement.style.display = 'none';

    if (message.payload.moreHistoryAvailable) {
        historyLoaderElement.dataset['oldestMessageTimestamp'] =
            message.payload.oldestMessageTimestamp.toString();
    } else {
        // Clear timestamp to prevent further load attempts
        historyLoaderElement.dataset['oldestMessageTimestamp'] = '';
    }
}

/**
 * Handle different minecraft server connection states
 * @param {ServerConnectionState} message
 */
function handleMinecraftServerConnectionState(message) {
    switch (message.payload) {
        case 'init':
            // Note: Initially used to clear messageHistory. As it turns out init events can also happen when already on a server.
            // Leaving this message in for potential debugging purposes because it can indicate minecraft server or connection issues.
            console.log('Received init event. It is something, init?');
            break;
        case 'join':
            console.log('Received join event. Welcome welcome!');

            // First clear whatever is in history as well as the player list so the slate is clean.
            // Note: the join event often comes after the client already received messages.
            // This is not a problem as they are stored in the message history and will loaded again once history is requested.
            // The player list is also send every few seconds so this is also not an issue.
            // Doing it in a different way would make things more complex than needed.
            playerList.clearAll();
            clearMessageHistory();

            // Then we update server info.
            serverInfo.update(message.server.name, message.server.identifier);

            // Finally request message history
            requestHistory(messageHistoryLimit);

            break;
        case 'disconnect':
            console.log('Received disconnect event. Sad to see you go.');
            serverInfo.clear();
            playerList.clearAll();
            break;
    }
}

/**
 * ======================
 *  Websocket related functions
 * ======================
 */

/**
 * Update status elements
 * @param {'connected' | 'disconnected' | 'error'} connectionStatus
 */
function updateWebsocketConnectionStatus(connectionStatus) {
    switch (connectionStatus) {
        case 'connected':
            statusElement.textContent = 'Join a server to chat';
            statusElement.dataset['status'] = 'connected';
            break;
        case 'disconnected':
            serverInfo.clear();
            statusElement.dataset['status'] = 'disconnected';
            statusElement.textContent = 'Disconnected from Minecraft';
            break;
        case 'error':
            serverInfo.clear();
            statusElement.dataset['status'] = 'error';
            statusElement.textContent = 'Error: See browser console';
            break;
    }
}

function connect() {
    const wsUrl = `ws://${location.host}/chat`;
    console.log(`[DEBUG] Attempting WebSocket connection to: ${wsUrl}`);
    ws = new WebSocket(wsUrl);

    ws.onopen = function () {
        console.log('[DEBUG] WebSocket onopen fired. Handshake successful. Connected to server at ' + wsUrl);
        updateWebsocketConnectionStatus('connected');
        reconnectAttempts = 0; // Reset attempts
    };

    ws.onclose = function (event) {
        console.log(`[DEBUG] WebSocket onclose fired. Code: ${event.code}, Reason: ${event.reason}. Clean close: ${event.wasClean}. Attempting to reconnect...`);
        updateWebsocketConnectionStatus('disconnected');

        if (reconnectAttempts < maxReconnectAttempts) {
            reconnectAttempts++;
            setTimeout(connect, 2000);
        }
    };

    ws.onerror = function (error) {
        console.error('[DEBUG] WebSocket onerror observed. Connection establishing failed or dropped.', error);
        updateWebsocketConnectionStatus('error');
    };

    ws.onmessage = function (event) {
        /** @type {string} */
        const rawJson = event.data;
        console.log('[DEBUG] Websocket onmessage received:', rawJson);

        try {
            const message = parseModServerMessage(rawJson);

            if (modVersion === null) {
                modVersion = message.modVersion;
                console.log('Mod version:', modVersion);
            } else if (modVersion !== message.modVersion) {
                console.warn(
                    'Mod version mismatch:',
                    modVersion,
                    message.modVersion,
                );
                location.reload();
            }

            switch (message.type) {
                case 'chatMessage':
                    handleChatMessage(message);
                    break;
                case 'historyMetaData':
                    handleHistoryMetaData(message);
                    break;
                case 'serverConnectionState':
                    handleMinecraftServerConnectionState(message);
                    break;
                case 'serverPlayerList':
                    playerList.updatePlayerList(message.payload);
            }
        } catch (e) {
            console.error('Error processing message:', e);
        }
    };
}

/**
 * History request parameters
 * @typedef {Object} HistoryRequest
 * @property {string} serverId - Unix timestamp
 * @property {number} limit - Number of messages to return
 * @property {number} [before] - Message ID to fetch history before
 */

/**
 * Send a message back to minecraft.
 * @param {'chat' | 'history' } type
 * @param {string | HistoryRequest} payload
 */
function sendWebsocketMessage(type, payload) {
    if (ws?.readyState !== WebSocket.OPEN) {
        console.log('WebSocket is not connected');
        updateWebsocketConnectionStatus('disconnected');
        return;
    }

    ws.send(
        JSON.stringify({
            type,
            payload,
        }),
    );
}

/**
 * Set the chat input error state
 * @param {boolean} isError
 */
function setChatInputError(isError) {
    const span = inputAlertElement.querySelector('span');
    if (!span) {
        return;
    }

    if (isError) {
        chatInputElement.classList.add('error');
        chatInputElement.ariaInvalid = 'true';
        inputAlertElement.style.display = 'flex';
        inputAlertElement.ariaHidden = 'false';
        span.textContent =
            'Only /tell, /msg, /w and /me commands are supported.';
    } else {
        chatInputElement.classList.remove('error');
        chatInputElement.ariaInvalid = 'false';
        inputAlertElement.style.display = 'none';
        inputAlertElement.ariaHidden = 'true';
        span.textContent = '';
    }
}

function sendChatMessage() {
    let message = chatInputElement.value;
    if (!message.trim()) {
        return;
    }

    const player = directMessageManager.getPlayer();
    if (player) {
        message = `/w ${player.playerName} ${message}`;
    }

    console.log(`Sending chat message: ${message}`);

    sendWebsocketMessage('chat', message);
    chatInputElement.value = '';

    // Keep focus on input to prevent keyboard from disappearing on mobile
    chatInputElement.focus();
}

/**
 * ======================
 *  Init
 * ======================
 */

connect();
initializeObfuscation();
