/**
 * The facts about DynamoDB items every store here agrees on (LambderDdbSdk):
 * the size DynamoDB counts for an attribute value against its item limit,
 * JSON as attribute values and back, and a number attribute read back when
 * it may be missing or not a number.
 */

import { describe, it, expect } from 'vitest';
import {
    attributeValueBytes, marshallJsonValue, MAX_ITEM_BYTES, storedNumber, unmarshallJsonValue,
} from '../../src/stores/LambderDdbSdk.js';

describe('attributeValueBytes', () => {
    it('sizes scalars as DynamoDB does: UTF-8 bytes, raw bytes, one byte for a boolean or null', () => {
        expect(attributeValueBytes({ S: 'order' })).toBe(5);
        expect(attributeValueBytes({ S: 'café' })).toBe(5);
        expect(attributeValueBytes({ B: new Uint8Array(10) })).toBe(10);
        expect(attributeValueBytes({ BOOL: true })).toBe(1);
        expect(attributeValueBytes({ NULL: true })).toBe(1);
    });

    it('sizes a number by its significant digits, a byte per two and one more', () => {
        expect(attributeValueBytes({ N: '0' })).toBe(2);
        expect(attributeValueBytes({ N: '7' })).toBe(2);
        expect(attributeValueBytes({ N: '42' })).toBe(2);
        expect(attributeValueBytes({ N: '123' })).toBe(3);
        // Leading and trailing zeroes are not stored, nor the sign, the point or an exponent.
        expect(attributeValueBytes({ N: '1700000000' })).toBe(2);
        expect(attributeValueBytes({ N: '0.0025' })).toBe(2);
        expect(attributeValueBytes({ N: '-123.45' })).toBe(4);
        expect(attributeValueBytes({ N: '1.5e-7' })).toBe(2);
        expect(attributeValueBytes({ N: '1e+21' })).toBe(2);
    });

    it('sizes a map or a list as three bytes plus, per element, a byte, its name and its value', () => {
        expect(attributeValueBytes({ L: [] })).toBe(3);
        expect(attributeValueBytes({ M: {} })).toBe(3);
        expect(attributeValueBytes({ L: [{ N: '1' }, { S: 'ab' }] })).toBe(3 + (1 + 2) + (1 + 2));
        expect(attributeValueBytes({ M: { store: { S: 'nyc-01' } } })).toBe(3 + (1 + 5 + 6));
        expect(attributeValueBytes(marshallJsonValue({ order: { items: [true] } }))).toBe(3 + (1 + 5 + (3 + (1 + 5 + (3 + (1 + 1))))));
    });

    it('throws on an attribute no store writes, rather than guessing its size', () => {
        expect(() => attributeValueBytes({ SS: ['a'] })).toThrow('attributeValueBytes cannot size an attribute of type SS');
        expect(() => attributeValueBytes({} as never)).toThrow('of type none');
    });

    it('names the item limit DynamoDB enforces', () => {
        expect(MAX_ITEM_BYTES).toBe(409_600);
    });
});

describe('marshallJsonValue and unmarshallJsonValue', () => {
    it('write each JSON type as the attribute type that holds it, the way the document client writes it', () => {
        expect(marshallJsonValue('ticket')).toEqual({ S: 'ticket' });
        expect(marshallJsonValue('')).toEqual({ S: '' });
        expect(marshallJsonValue(19.99)).toEqual({ N: '19.99' });
        expect(marshallJsonValue(-0.25)).toEqual({ N: '-0.25' });
        expect(marshallJsonValue(1790000000)).toEqual({ N: '1790000000' });
        expect(marshallJsonValue(true)).toEqual({ BOOL: true });
        expect(marshallJsonValue(null)).toEqual({ NULL: true });
        expect(marshallJsonValue([])).toEqual({ L: [] });
        expect(marshallJsonValue({})).toEqual({ M: {} });
        expect(marshallJsonValue({ order: { lines: [{ sku: 'A-1', quantity: 2 }], paid: false, note: null } })).toEqual({
            M: { order: { M: {
                lines: { L: [{ M: { sku: { S: 'A-1' }, quantity: { N: '2' } } }] },
                paid: { BOOL: false },
                note: { NULL: true },
            } } },
        });
    });

    it('read every JSON value back as it was written', () => {
        const values = ['', 'Zürich', 0, -0.5, 0.1 + 0.2, 1e-7, 2 ** 53 + 2, 1e21, true, false, null, [], {}, [1, 'a', [null]], { store: { open: true, hours: [9, 17] } }];
        for(const value of values) expect(unmarshallJsonValue(marshallJsonValue(value))).toEqual(value);
    });

    it('keep a __proto__ key as data, as JSON.parse does, rather than setting a prototype', () => {
        const parsed = JSON.parse('{"__proto__":{"admin":true},"role":"user"}');
        const attribute = marshallJsonValue(parsed);
        expect(Object.keys(attribute.M!)).toEqual(['__proto__', 'role']);

        const read = unmarshallJsonValue(attribute) as Record<string, unknown>;
        expect(Object.getPrototypeOf(read)).toBe(Object.prototype);
        expect((read as { admin?: unknown }).admin).toBeUndefined();
        expect(JSON.stringify(read)).toBe(JSON.stringify(parsed));
    });

    it('refuse what JSON cannot hold, rather than guessing', () => {
        expect(() => marshallJsonValue(undefined)).toThrow('marshallJsonValue cannot store a value of type undefined');
        expect(() => marshallJsonValue({ at: undefined })).toThrow('of type undefined');
        expect(() => marshallJsonValue(Number.NaN)).toThrow('cannot store the number NaN');
        expect(() => marshallJsonValue(Infinity)).toThrow('cannot store the number Infinity');
        expect(() => marshallJsonValue(() => 1)).toThrow('of type function');
        expect(() => marshallJsonValue(new Set(['a']))).toThrow('of type object');
        expect(() => marshallJsonValue(new Date(0))).toThrow('of type object');
        expect(() => unmarshallJsonValue({ SS: ['a'] })).toThrow('cannot read an attribute of type SS as JSON');
        expect(() => unmarshallJsonValue({ B: new Uint8Array(1) })).toThrow('of type B');
    });
});

describe('storedNumber', () => {
    it('reads a number attribute, or the fallback when it is missing or not a number', () => {
        expect(storedNumber('1700000000', 0)).toBe(1_700_000_000);
        expect(storedNumber('-2.5', 0)).toBe(-2.5);
        expect(storedNumber(undefined, 200)).toBe(200);
        expect(storedNumber('nope', 0)).toBe(0);
        expect(storedNumber('Infinity', 7)).toBe(7);
    });
});
