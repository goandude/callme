import { NextApiRequest, NextApiResponse } from 'next';
import crypto from 'crypto';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
    if (req.method !== 'GET') {
        return res.status(405).send('Method Not Allowed');
    }

    try {
        const turnSecret = process.env.TURN_API_SECRET;
        if (!turnSecret) {
            throw new Error('TURN_API_SECRET is not set in environment variables.');
        }

        // Time-to-live in seconds (e.g., 24 hours)
        const ttl = 86400;

        // The username must contain the expiration timestamp
        const timestamp = Math.floor(Date.now() / 1000) + ttl;
        const username = `${timestamp}:your-app-identifier`; // You can use a static identifier here

        // The credential is the HMAC-SHA1 hash of the username, using your secret key
        const credential = crypto
            .createHmac('sha1', turnSecret)
            .update(username)
            .digest('base64');
        
        // Return the ICE server configuration
        const iceServers = [
            { urls: 'stun:stun.l.google.com:19302' },
            {
                urls: "turn:relay1.expressturn.com:3480", // Your specific TURN URL
                username,
                credential,
            },
        ];

        res.status(200).json(iceServers);

    } catch (error) {
        console.error('Error generating TURN credentials:', error);
        res.status(500).json({ error: 'Failed to generate TURN credentials.' });
    }
}