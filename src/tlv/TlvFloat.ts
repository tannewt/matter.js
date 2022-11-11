/**
 * @license
 * Copyright 2022 Project CHIP Authors
 * SPDX-License-Identifier: Apache-2.0
 */

import { DataReaderLE } from "../util/DataReaderLE";
import { DataWriterLE } from "../util/DataWriterLE";
import { TlvType, TlvCodec, TlvTag, TlvLength, TlvTypeLength } from "./TlvCodec";
import { TlvSchema } from "./TlvSchema";

const FLOAT32_MIN = -340282346638528859811704183484516925440.0;
const FLOAT32_MAX = 340282346638528859811704183484516925440.0;

/**
 * Schema to encode a float in TLV.
 * 
 * @see {@link MatterCoreSpecificationV1_0} § A.11.1
 */
 class FloatSchema extends TlvSchema<number> {
    constructor(
        private readonly min?: number,
        private readonly max?: number,
        private readonly precision: TlvLength.FourBytes | TlvLength.EightBytes = TlvLength.EightBytes,
    ) {
        super();
    }

    /** @override */
    protected encodeTlv(writer: DataWriterLE, value: number, tag: TlvTag = {}): void {
        const typeLength: TlvTypeLength = { type: TlvType.Float, length: this.precision };
        TlvCodec.writeTag(writer, typeLength, tag);
        TlvCodec.writePrimitive(writer, typeLength, value);
    }

    /** @override */
    protected decodeTlv(reader: DataReaderLE) {
        const { tag, typeLength } = TlvCodec.readTagType(reader);
        if (typeLength.type !== TlvType.Float) throw new Error(`Unexpected type ${typeLength.type}.`);
        let value = TlvCodec.readPrimitive(reader, typeLength);
        this.validate(value);
        return { tag, value };
    }

    /** @override */
    validate(value: number): void {
        if (this.min !== undefined && value < this.min) throw new Error(`Invalid value: ${value} is below the minimum, ${this.min}.`);
        if (this.max !== undefined && value > this.max) throw new Error(`Invalid value: ${value} is above the maximum, ${this.min}.`);
    }
}


/** Double TLV schema bounded by a min / max. */
export const TlvBoundedDouble = (
    { min, max }: { min?: number, max?: number } = {},
    precision?: TlvLength.FourBytes | TlvLength.EightBytes,
) => new FloatSchema(min, max, precision);

/** Float TLV schema. */
export const TlvFloat = TlvBoundedDouble({ min: FLOAT32_MIN, max: FLOAT32_MAX}, TlvLength.FourBytes);

/** Double TLV schema. */
export const TlvDouble = TlvBoundedDouble(); // number type is a double internally so no need to specify a range
