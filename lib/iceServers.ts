console.log("TURN URL:", process.env.NEXT_PUBLIC_TURN_URL);
console.log("TURN Username:", process.env.NEXT_PUBLIC_TURN_USERNAME);
console.log("TURN Password:", process.env.NEXT_PUBLIC_TURN_PASSWORD);

export const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    {
        urls: process.env.NEXT_PUBLIC_TURN_URL!,
        username: process.env.NEXT_PUBLIC_TURN_USERNAME!,
        credential: process.env.NEXT_PUBLIC_TURN_PASSWORD!,
    },
];