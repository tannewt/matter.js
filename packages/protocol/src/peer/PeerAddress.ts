/**
 * @license
 * Copyright 2022-2024 Matter.js Authors
 * SPDX-License-Identifier: Apache-2.0
 */

import { FabricIndex, NodeId } from "@matter.js/types";

/**
 * This is the "logical" address of a peer node consisting of a fabric and node ID.
 */
export interface PeerAddress {
    fabricIndex: FabricIndex;
    nodeId: NodeId;
}

const interned = Symbol("interned-logical-address");

const internedAddresses = new Map<FabricIndex, Map<NodeId, PeerAddress>>();

/**
 * Obtain a canonical instance of a logical address.
 *
 * This allows for identification based on object comparison.  Interned addresses render to a string in the format
 * "@<fabric index>:<node id>"
 */
export function PeerAddress(address: PeerAddress): PeerAddress {
    if (interned in address) {
        return address;
    }

    let internedFabric = internedAddresses.get(address.fabricIndex);
    if (internedFabric === undefined) {
        internedAddresses.set(address.fabricIndex, (internedFabric = new Map()));
    }

    let internedAddress = internedFabric.get(address.nodeId);
    if (internedAddress) {
        return internedAddress;
    }

    internedFabric.set(
        address.nodeId,
        (internedAddress = {
            ...address,

            [interned]: true,

            toString() {
                const nodeStr = this.nodeId > 0xffff ? `0x${this.nodeId.toString(16)}` : this.nodeId;
                return `peer@${this.fabricIndex}:${nodeStr}`;
            },
        } as PeerAddress),
    );

    return internedAddress;
}

/**
 * A collection of items keyed by logical address.
 */
export class PeerAddressMap<T> extends Map<PeerAddress, T> {
    override delete(key: PeerAddress) {
        return super.delete(PeerAddress(key));
    }

    override has(key: PeerAddress) {
        return super.has(PeerAddress(key));
    }

    override set(key: PeerAddress, value: T) {
        return super.set(PeerAddress(key), value);
    }

    override get(key: PeerAddress) {
        return super.get(PeerAddress(key));
    }
}
