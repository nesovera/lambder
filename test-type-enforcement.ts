// Test file to verify LambderMSW type enforcement
import LambderMSW from './src/LambderMSW';
import type { ApiContract } from './src/LambderApiContract';

// Define a test API contract
type TestContract = ApiContract<{
    'public.getInitialPageData': {
        input: void;
        output: {
            userLocationData: {
                country: string;
                region: string;
                regionCode: string;
                city: string;
                zipCode: string;
                lat: number;
                lng: number;
            };
            sessionUser: {
                id: string;
                username: string;
                email: string;
                name: string;
                bio: string;
                // NOTE: 's' property should NOT be here
            };
        };
    };
}>;

const apiMocker = new LambderMSW<TestContract>({
    apiPath: '/secure',
});

// TEST 1: Extra properties - TypeScript allows this due to structural typing
const handler1 = apiMocker.mockApi(
    'public.getInitialPageData',
    async () => {
        return {
            userLocationData: {
                country: 'United States',
                region: 'California',
                regionCode: 'CA',
                city: 'San Francisco',
                zipCode: '94102',
                lat: 37.7749,
                lng: -122.4194,
            },
            sessionUser: {
                id: 'mock-user-123',
                username: 'mockuser',
                email: 'mock@example.com',
                name: 'Mock User',
                bio: 'This is a mock user for development',
                s: 43  // ⚠️ Extra property - TypeScript structural typing allows this
            },
        };
    }
);

// TEST 2: Missing required property - THIS WILL CAUSE AN ERROR!
const handler2 = apiMocker.mockApi(
    'public.getInitialPageData',
    async () => {
        return {
            userLocationData: {
                country: 'United States',
                region: 'California',
                regionCode: 'CA',
                city: 'San Francisco',
                zipCode: '94102',
                lat: 37.7749,
                lng: -122.4194,
            },
            sessionUser: {
                id: 'mock-user-123',
                username: 'mockuser',
                email: 'mock@example.com',
                name: 'Mock User',
                // bio: 'This is a mock user for development',  // ❌ Missing required property - ERROR!
            },
        };
    }
);

// TEST 3: Wrong type - THIS WILL CAUSE AN ERROR!
const handler3 = apiMocker.mockApi(
    'public.getInitialPageData',
    async () => {
        return {
            userLocationData: {
                country: 'United States',
                region: 'California',
                regionCode: 'CA',
                city: 'San Francisco',
                zipCode: '94102',
                lat: 37.7749,
                lng: -122.4194,
            },
            sessionUser: {
                id: 123,  // ❌ Wrong type - should be string - ERROR!
                username: 'mockuser',
                email: 'mock@example.com',
                name: 'Mock User',
                bio: 'This is a mock user for development',
            },
        };
    }
);

console.log('Check for TypeScript errors above!');
