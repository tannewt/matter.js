/**
 * @license
 * Copyright 2022-2024 Matter.js Authors
 * SPDX-License-Identifier: Apache-2.0
 */

import { DiscoveryData, ScannerSet } from "#common/Scanner.js";
import {
    anyPromise,
    BasicSet,
    ChannelType,
    Construction,
    createPromise,
    Environment,
    Environmental,
    ImmutableSet,
    ImplementationError,
    isIPv6,
    Logger,
    NetInterfaceSet,
    NoResponseTimeoutError,
    ObservableSet,
    PromiseQueue,
    ServerAddressIp,
    serverAddressToString,
    Time,
    Timer,
} from "#general";
import { InteractionClient } from "#interaction/InteractionClient.js";
import { MdnsScanner } from "#mdns/MdnsScanner.js";
import { PeerAddress, PeerAddressMap } from "#peer/PeerAddress.js";
import { CaseClient, Session } from "#session/index.js";
import { SessionManager } from "#session/SessionManager.js";
import { AttributeId, ClusterId, EndpointNumber, EventNumber, SECURE_CHANNEL_PROTOCOL_ID } from "@matter.js/types";
import { ChannelManager, NoChannelError } from "../protocol/ChannelManager.js";
import { ExchangeManager, ExchangeProvider, MessageChannel } from "../protocol/ExchangeManager.js";
import { RetransmissionLimitReachedError } from "../protocol/MessageExchange.js";
import { ControllerDiscovery, DiscoveryError, PairRetransmissionLimitReachedError } from "./ControllerDiscovery.js";
import { OperationalPeer } from "./OperationalPeer.js";
import { PeerStore } from "./PeerStore.js";

const logger = Logger.get("PeerSet");

const RECONNECTION_POLLING_INTERVAL_MS = 600_000; // 10 minutes
const RETRANSMISSION_DISCOVERY_TIMEOUT_MS = 5_000;

const CONCURRENT_QUEUED_INTERACTIONS = 4;
const INTERACTION_QUEUE_DELAY_MS = 100;

/**
 * Types of discovery that may be performed when connecting operationally.
 */
export enum NodeDiscoveryType {
    /** No discovery is done, in calls means that only known addresses are tried. */
    None = 0,

    /** Retransmission discovery means that we ignore known addresses and start a query for 5s. */
    RetransmissionDiscovery = 1,

    /** Timed discovery means that the device is discovered for a defined timeframe, including known addresses. */
    TimedDiscovery = 2,

    /** Full discovery means that the device is discovered until it is found, excluding known addresses. */
    FullDiscovery = 3,
}

/**
 * Configuration for discovering when establishing a peer connection.
 */
export interface DiscoveryOptions {
    discoveryType?: NodeDiscoveryType;
    timeoutSeconds?: number;
    discoveryData?: DiscoveryData;
}

interface RunningDiscovery {
    type: NodeDiscoveryType;
    promises?: (() => Promise<MessageChannel>)[];
    timer?: Timer;
}

/**
 * Interfaces {@link PeerSet} with other components.
 */
export interface PeerSetContext {
    sessions: SessionManager;
    channels: ChannelManager;
    exchanges: ExchangeManager;
    scanners: ScannerSet;
    netInterfaces: NetInterfaceSet;
    store: PeerStore;
}

// TODO Convert this into a proper persisted store
export type NodeCachedData = {
    attributeValues: Map<
        string,
        {
            endpointId: EndpointNumber;
            clusterId: ClusterId;
            attributeId: AttributeId;
            attributeName: string;
            value: any;
        }
    >;
    clusterDataVersions: Map<string, { endpointId: EndpointNumber; clusterId: ClusterId; dataVersion: number }>;
    maxEventNumber?: EventNumber;
};

/**
 * Manages operational connections to peers on shared fabric.
 */
export class PeerSet implements ImmutableSet<OperationalPeer>, ObservableSet<OperationalPeer> {
    readonly #sessions: SessionManager;
    readonly #channels: ChannelManager;
    readonly #exchanges: ExchangeManager;
    readonly #scanners: ScannerSet;
    readonly #netInterfaces: NetInterfaceSet;
    readonly #caseClient: CaseClient;
    readonly #peers = new BasicSet<OperationalPeer>();
    readonly #peersByAddress = new PeerAddressMap<OperationalPeer>();
    readonly #runningPeerDiscoveries = new PeerAddressMap<RunningDiscovery>();
    readonly #construction: Construction<PeerSet>;
    readonly #store: PeerStore;
    readonly #interactionQueue = new PromiseQueue(CONCURRENT_QUEUED_INTERACTIONS, INTERACTION_QUEUE_DELAY_MS);
    readonly #nodeCachedData = new Map<PeerAddress, NodeCachedData>(); // Temporarily until we store it in new API

    constructor(context: PeerSetContext) {
        const { sessions, channels, exchanges, scanners, netInterfaces, store } = context;

        this.#sessions = sessions;
        this.#channels = channels;
        this.#exchanges = exchanges;
        this.#scanners = scanners;
        this.#netInterfaces = netInterfaces;
        this.#store = store;
        this.#caseClient = new CaseClient(this.#sessions);

        this.#peers.added.on(peer => {
            peer.address = PeerAddress(peer.address);
            this.#peersByAddress.set(peer.address, peer);
        });

        this.#peers.deleted.on(peer => {
            this.#peersByAddress.delete(peer.address);
        });

        this.#sessions.resubmissionStarted.on(this.#handleResubmissionStarted.bind(this));

        this.#construction = Construction(this, async () => {
            for (const peer of await this.#store.loadPeers()) {
                this.#peers.add(peer);
            }
        });
    }

    get added() {
        return this.#peers.added;
    }

    get deleted() {
        return this.#peers.deleted;
    }

    has(item: PeerAddress | OperationalPeer) {
        if ("address" in item) {
            return this.#peers.has(item);
        }
        return this.#peersByAddress.has(item);
    }

    get size() {
        return this.#peers.size;
    }

    find(predicate: (item: OperationalPeer) => boolean | undefined) {
        return this.#peers.find(predicate);
    }

    filter(predicate: (item: OperationalPeer) => boolean | undefined) {
        return this.#peers.filter(predicate);
    }

    map<T>(mapper: (item: OperationalPeer) => T) {
        return this.#peers.map(mapper);
    }

    [Symbol.iterator]() {
        return this.#peers[Symbol.iterator]();
    }

    get construction() {
        return this.#construction;
    }

    [Environmental.create](env: Environment) {
        const instance = new PeerSet({
            sessions: env.get(SessionManager),
            channels: env.get(ChannelManager),
            exchanges: env.get(ExchangeManager),
            scanners: env.get(ScannerSet),
            netInterfaces: env.get(NetInterfaceSet),
            store: env.get(PeerStore),
        });
        env.set(PeerSet, instance);
        return instance;
    }

    get peers() {
        return this.#peers;
    }

    /**
     * Connect to a node on a fabric.
     */
    async connect(address: PeerAddress, discoveryOptions: DiscoveryOptions): Promise<InteractionClient> {
        const { discoveryData } = discoveryOptions;

        address = PeerAddress(address);

        let channel: MessageChannel;
        try {
            channel = this.#channels.getChannel(address);
        } catch (error) {
            NoChannelError.accept(error);

            channel = await this.#resume(address, discoveryOptions);
        }

        const cachedData =
            this.#nodeCachedData.get(address) ??
            ({
                attributeValues: new Map(),
                clusterDataVersions: new Map(),
            } as NodeCachedData);
        this.#nodeCachedData.set(address, cachedData);

        return new InteractionClient(
            new ExchangeProvider(this.#exchanges, channel, async () => {
                if (!this.#channels.hasChannel(address)) {
                    throw new RetransmissionLimitReachedError(
                        `Device ${PeerAddress(address)} is currently not reachable.`,
                    );
                }
                await this.#channels.removeAllNodeChannels(address);

                // Try to use first result for one last try before we need to reconnect
                const operationalAddress = this.#knownOperationalAddressFor(address);
                if (operationalAddress === undefined) {
                    logger.info(
                        `Re-discovering device failed (no address found), remove all sessions for ${PeerAddress(address)}`,
                    );
                    // We remove all sessions, this also informs the PairedNode class
                    await this.#sessions.removeAllSessionsForNode(address);
                    throw new RetransmissionLimitReachedError(
                        `No operational address found for ${PeerAddress(address)}`,
                    );
                }
                if (
                    (await this.#reconnectKnownAddress(address, operationalAddress, discoveryData, 2_000)) === undefined
                ) {
                    throw new RetransmissionLimitReachedError(`${PeerAddress(address)} is not reachable.`);
                }
                return this.#channels.getChannel(address);
            }),
            address,
            this.#interactionQueue,
            cachedData,
        );
    }

    /**
     * Retrieve a peer by address.
     */
    get(peer: PeerAddress | OperationalPeer) {
        if ("address" in peer) {
            return this.#peersByAddress.get(peer.address);
        }
        return this.#peersByAddress.get(peer);
    }

    /**
     * Terminate any active peer connection.
     */
    async disconnect(peer: PeerAddress | OperationalPeer) {
        const address = this.get(peer)?.address;
        if (address === undefined) {
            return;
        }

        await this.#sessions.removeAllSessionsForNode(address, true);
        await this.#channels.removeAllNodeChannels(address);
    }

    /**
     * Forget a known peer.
     */
    async delete(peer: PeerAddress | OperationalPeer) {
        const actual = this.get(peer);
        if (actual === undefined) {
            return;
        }

        logger.info(`Removing ${actual.address}`);
        this.#peers.delete(actual);
        await this.#store.deletePeer(actual.address);
        await this.disconnect(actual);
        await this.#sessions.deleteResumptionRecord(actual.address);
    }

    async close() {
        const mdnsScanner = this.#scanners.scannerFor(ChannelType.UDP) as MdnsScanner | undefined;
        for (const [address, { timer }] of this.#runningPeerDiscoveries.entries()) {
            timer?.stop();

            // This ends discovery without triggering promises
            mdnsScanner?.cancelOperationalDeviceDiscovery(this.#sessions.fabricFor(address), address.nodeId, false);
        }
        this.#interactionQueue.close();
    }

    /**
     * Resume a device connection and establish a CASE session that was previously paired with the controller. This
     * method will try to connect to the device using the previously used server address (if set). If that fails, the
     * device is discovered again using its operational instance details.
     * It returns the operational MessageChannel on success.
     */
    async #resume(address: PeerAddress, discoveryOptions?: DiscoveryOptions) {
        const operationalAddress = this.#knownOperationalAddressFor(address);

        try {
            return await this.#connectOrDiscoverNode(address, operationalAddress, discoveryOptions);
        } catch (error) {
            if (
                (error instanceof DiscoveryError || error instanceof NoResponseTimeoutError) &&
                this.#peersByAddress.has(address)
            ) {
                logger.info(`Resume failed, remove all sessions for ${PeerAddress(address)}`);
                // We remove all sessions, this also informs the PairedNode class
                await this.#sessions.removeAllSessionsForNode(address);
            }
            throw error;
        }
    }

    async #connectOrDiscoverNode(
        address: PeerAddress,
        operationalAddress?: ServerAddressIp,
        discoveryOptions: DiscoveryOptions = {},
    ) {
        address = PeerAddress(address);
        const {
            discoveryType: requestedDiscoveryType = NodeDiscoveryType.FullDiscovery,
            timeoutSeconds,
            discoveryData = this.#peersByAddress.get(address)?.discoveryData,
        } = discoveryOptions;
        if (timeoutSeconds !== undefined && requestedDiscoveryType !== NodeDiscoveryType.TimedDiscovery) {
            throw new ImplementationError("Cannot set timeout without timed discovery.");
        }
        if (requestedDiscoveryType === NodeDiscoveryType.RetransmissionDiscovery) {
            throw new ImplementationError("Cannot set retransmission discovery type.");
        }

        const mdnsScanner = this.#scanners.scannerFor(ChannelType.UDP) as MdnsScanner | undefined;
        if (!mdnsScanner) {
            throw new ImplementationError("Cannot discover device without mDNS scanner.");
        }

        const existingDiscoveryDetails = this.#runningPeerDiscoveries.get(address) ?? {
            type: NodeDiscoveryType.None,
        };

        // If we currently run another "lower" retransmission type we cancel it
        if (
            existingDiscoveryDetails.type !== NodeDiscoveryType.None &&
            existingDiscoveryDetails.type < requestedDiscoveryType
        ) {
            mdnsScanner.cancelOperationalDeviceDiscovery(this.#sessions.fabricFor(address), address.nodeId);
            this.#runningPeerDiscoveries.delete(address);
            existingDiscoveryDetails.type = NodeDiscoveryType.None;
        }

        const { type: runningDiscoveryType, promises } = existingDiscoveryDetails;

        // If we have a last known address try to reach the device directly when we are not already discovering
        // In worst case parallel cases we do this step twice, but that's ok
        if (
            operationalAddress !== undefined &&
            (runningDiscoveryType === NodeDiscoveryType.None || requestedDiscoveryType === NodeDiscoveryType.None)
        ) {
            const directReconnection = await this.#reconnectKnownAddress(address, operationalAddress, discoveryData);
            if (directReconnection !== undefined) {
                return directReconnection;
            }
            if (requestedDiscoveryType === NodeDiscoveryType.None) {
                throw new DiscoveryError(`${address} is not reachable right now.`);
            }
        }

        if (promises !== undefined) {
            if (runningDiscoveryType > requestedDiscoveryType) {
                // We already run a "longer" discovery, so we know it is unreachable for now
                throw new DiscoveryError(`${address} is not reachable right now and discovery already running.`);
            } else {
                // If we are already discovering this node, so we reuse promises
                return await anyPromise(promises);
            }
        }

        const discoveryPromises = new Array<() => Promise<MessageChannel>>();
        let reconnectionPollingTimer: Timer | undefined;

        if (operationalAddress !== undefined) {
            // Additionally to general discovery we also try to poll the formerly known operational address
            if (requestedDiscoveryType === NodeDiscoveryType.FullDiscovery) {
                const { promise, resolver, rejecter } = createPromise<MessageChannel>();

                reconnectionPollingTimer = Time.getPeriodicTimer(
                    "Controller reconnect",
                    RECONNECTION_POLLING_INTERVAL_MS,
                    async () => {
                        try {
                            logger.debug(`Polling for device at ${serverAddressToString(operationalAddress)} ...`);
                            const result = await this.#reconnectKnownAddress(
                                address,
                                operationalAddress,
                                discoveryData,
                            );
                            if (result !== undefined && reconnectionPollingTimer?.isRunning) {
                                reconnectionPollingTimer?.stop();
                                mdnsScanner.cancelOperationalDeviceDiscovery(
                                    this.#sessions.fabricFor(address),
                                    address.nodeId,
                                );
                                this.#runningPeerDiscoveries.delete(address);
                                resolver(result);
                            }
                        } catch (error) {
                            if (reconnectionPollingTimer?.isRunning) {
                                reconnectionPollingTimer?.stop();
                                mdnsScanner.cancelOperationalDeviceDiscovery(
                                    this.#sessions.fabricFor(address),
                                    address.nodeId,
                                );
                                this.#runningPeerDiscoveries.delete(address);
                                rejecter(error);
                            }
                        }
                    },
                ).start();

                discoveryPromises.push(() => promise);
            }
        }

        discoveryPromises.push(async () => {
            const scanResult = await ControllerDiscovery.discoverOperationalDevice(
                this.#sessions.fabricFor(address),
                address.nodeId,
                mdnsScanner,
                timeoutSeconds,
                timeoutSeconds === undefined,
            );
            const { timer } = this.#runningPeerDiscoveries.get(address) ?? {};
            timer?.stop();
            this.#runningPeerDiscoveries.delete(address);

            const { result } = await ControllerDiscovery.iterateServerAddresses(
                [scanResult],
                NoResponseTimeoutError,
                async () => {
                    const device = mdnsScanner.getDiscoveredOperationalDevice(
                        this.#sessions.fabricFor(address),
                        address.nodeId,
                    );
                    return device !== undefined ? [device] : [];
                },
                async (operationalAddress, peer) => {
                    const result = await this.#pair(address, operationalAddress, peer);
                    await this.#addOrUpdatePeer(address, operationalAddress, {
                        ...discoveryData,
                        ...peer,
                    });
                    return result;
                },
            );

            return result;
        });

        this.#runningPeerDiscoveries.set(address, {
            type: requestedDiscoveryType,
            promises: discoveryPromises,
            timer: reconnectionPollingTimer,
        });

        return await anyPromise(discoveryPromises).finally(() => this.#runningPeerDiscoveries.delete(address));
    }

    async #reconnectKnownAddress(
        address: PeerAddress,
        operationalAddress: ServerAddressIp,
        discoveryData?: DiscoveryData,
        expectedProcessingTimeMs?: number,
    ): Promise<MessageChannel | undefined> {
        address = PeerAddress(address);

        const { ip, port } = operationalAddress;
        try {
            logger.debug(
                `Resuming connection to ${PeerAddress(address)} at ${ip}:${port}${
                    expectedProcessingTimeMs !== undefined
                        ? ` with expected processing time of ${expectedProcessingTimeMs}ms`
                        : ""
                }`,
            );
            const channel = await this.#pair(address, operationalAddress, discoveryData, expectedProcessingTimeMs);
            await this.#addOrUpdatePeer(address, operationalAddress);
            return channel;
        } catch (error) {
            if (error instanceof NoResponseTimeoutError) {
                logger.debug(
                    `Failed to resume connection to ${address} connection with ${ip}:${port}, discover the node:`,
                    error,
                );
                // We remove all sessions, this also informs the PairedNode class
                await this.#sessions.removeAllSessionsForNode(address);
                return undefined;
            } else {
                throw error;
            }
        }
    }

    /** Pair with an operational device (already commissioned) and establish a CASE session. */
    async #pair(
        address: PeerAddress,
        operationalServerAddress: ServerAddressIp,
        discoveryData?: DiscoveryData,
        expectedProcessingTimeMs?: number,
    ) {
        const { ip, port } = operationalServerAddress;
        // Do CASE pairing
        const isIpv6Address = isIPv6(ip);
        const operationalInterface = this.#netInterfaces.interfaceFor(
            ChannelType.UDP,
            isIpv6Address ? "::" : "0.0.0.0",
        );

        if (operationalInterface === undefined) {
            throw new PairRetransmissionLimitReachedError(
                `IPv${
                    isIpv6Address ? "6" : "4"
                } interface not initialized for port ${port}. Cannot use ${ip} for pairing.`,
            );
        }

        const operationalChannel = await operationalInterface.openChannel(operationalServerAddress);
        const { sessionParameters } = this.#sessions.findResumptionRecordByAddress(address) ?? {};
        const unsecureSession = this.#sessions.createInsecureSession({
            // Use the session parameters from MDNS announcements when available and rest is assumed to be fallbacks
            sessionParameters: {
                idleIntervalMs: discoveryData?.SII ?? sessionParameters?.idleIntervalMs,
                activeIntervalMs: discoveryData?.SAI ?? sessionParameters?.activeIntervalMs,
                activeThresholdMs: discoveryData?.SAT ?? sessionParameters?.activeThresholdMs,
            },
            isInitiator: true,
        });
        const operationalUnsecureMessageExchange = new MessageChannel(operationalChannel, unsecureSession);
        let operationalSecureSession;
        try {
            const exchange = this.#exchanges.initiateExchangeWithChannel(
                operationalUnsecureMessageExchange,
                SECURE_CHANNEL_PROTOCOL_ID,
            );

            try {
                const { session, resumed } = await this.#caseClient.pair(
                    exchange,
                    this.#sessions.fabricFor(address),
                    address.nodeId,
                    expectedProcessingTimeMs,
                );
                operationalSecureSession = session;

                if (!resumed) {
                    // When the session was not resumed then most likely the device firmware got updated, so we clear the cache
                    this.#nodeCachedData.delete(address);
                }
            } catch (e) {
                await exchange.close();
                throw e;
            }
        } catch (e) {
            NoResponseTimeoutError.accept(e);

            // Convert error
            throw new PairRetransmissionLimitReachedError(e.message);
        }
        await unsecureSession.destroy();
        const channel = new MessageChannel(operationalChannel, operationalSecureSession);
        await this.#channels.setChannel(address, channel);
        return channel;
    }

    /**
     * Obtain an operational address for a logical address from cache.
     */
    #knownOperationalAddressFor(address: PeerAddress) {
        const mdnsScanner = this.#scanners.scannerFor(ChannelType.UDP) as MdnsScanner | undefined;
        const discoveredAddresses = mdnsScanner?.getDiscoveredOperationalDevice(
            this.#sessions.fabricFor(address),
            address.nodeId,
        );
        const lastKnownAddress = this.#getLastOperationalAddress(address);

        if (
            lastKnownAddress !== undefined &&
            discoveredAddresses !== undefined &&
            discoveredAddresses.addresses.some(
                ({ ip, port }) => ip === lastKnownAddress.ip && port === lastKnownAddress.port,
            )
        ) {
            // We found the same address, so assume somehow cached response because we just tried to connect,
            // and it failed, so clear list
            discoveredAddresses.addresses.length = 0;
        }

        // Try to use first result for one last try before we need to reconnect
        return discoveredAddresses?.addresses[0];
    }

    async #addOrUpdatePeer(
        address: PeerAddress,
        operationalServerAddress: ServerAddressIp,
        discoveryData?: DiscoveryData,
    ) {
        let peer = this.#peersByAddress.get(address);
        if (peer === undefined) {
            peer = { address };
            this.#peers.add(peer);
        }
        peer.operationalAddress = operationalServerAddress;
        if (discoveryData !== undefined) {
            peer.discoveryData = {
                ...peer.discoveryData,
                ...discoveryData,
            };
        }
        await this.#store.updatePeer(peer);
    }

    #getLastOperationalAddress(address: PeerAddress) {
        return this.#peersByAddress.get(address)?.operationalAddress;
    }

    #handleResubmissionStarted(session: Session) {
        if (!session.isSecure) {
            // For insecure sessions from CASE/PASE session establishments we do not need to do anything
            return;
        }
        const { associatedFabric: fabric, peerNodeId: nodeId } = session;
        if (fabric === undefined || nodeId === undefined) {
            return;
        }
        const address = fabric.addressOf(nodeId);
        if (this.#runningPeerDiscoveries.has(address)) {
            // We already discover for this node, so we do not need to start a new discovery
            return;
        }
        this.#runningPeerDiscoveries.set(address, { type: NodeDiscoveryType.RetransmissionDiscovery });
        this.#scanners
            .scannerFor(ChannelType.UDP)
            ?.findOperationalDevice(fabric, nodeId, RETRANSMISSION_DISCOVERY_TIMEOUT_MS, true)
            .catch(error => {
                logger.error(`Failed to discover ${address} after resubmission started.`, error);
            })
            .finally(() => {
                if (this.#runningPeerDiscoveries.get(address)?.type === NodeDiscoveryType.RetransmissionDiscovery) {
                    this.#runningPeerDiscoveries.delete(address);
                }
            });
    }
}
