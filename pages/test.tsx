//
// Filename: /pages/test.tsx
// Description: A page for testing multi-user scenarios with robust state management.
//
import { useState, useRef, useEffect, FC, KeyboardEvent } from 'react';
import { supabase } from '../lib/supabaseClient';
import { RealtimeChannel } from '@supabase/supabase-js';

// --- Reusable Types ---
interface OfferPayload { offer: RTCSessionDescriptionInit; userId: string; }
interface AnswerPayload { answer: RTCSessionDescriptionInit; userId: string; }
interface CandidatePayload { candidate: RTCIceCandidateInit; userId:string; }
type SignalPayload = OfferPayload | AnswerPayload | CandidatePayload;

// --- Reusable SVG Icon Components ---
const PhoneIcon = () => (<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12.38,1a1,1,0,0,0-1,.22L3.83,8.08A3,3,0,0,0,3,10.24V14a3,3,0,0,0,3,3H9.45a1,1,0,0,0,.86-.49l2.86-4.29a1,1,0,0,1,1.17-.42l2.33.78a1,1,0,0,0,1.19-.88l1-5.46a1,1,0,0,0-.9-1.15l-6-.86A1,1,0,0,0,12.38,1Z"/></svg>);
const VideoIcon = ({ off }: { off: boolean }) => (<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M20.5,12.35a1,1,0,0,1,0,1.3l-3,2.25A1,1,0,0,1,16,15.06V11.94a1,1,0,0,1,1.5-.86ZM14,8a2,2,0,0,0-2,2V20a2,2,0,0,0,2,2H22a2,2,0,0,0,2-2V10a2,2,0,0,0-2-2Z"/>{off && <path d="M3.29,4.71a1,1,0,0,0-1.42,1.42l18,18a1,1,0,0,0,1.42,0,1,1,0,0,0,0-1.42Z"/>}</svg>);
const MicIcon = ({ off }: { off: boolean }) => (<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12,14a3,3,0,0,0,3-3V5A3,3,0,0,0,9,5v6A3,3,0,0,0,12,14Z"/><path d="M17,11a1,1,0,0,0-2,0A3,3,0,0,1,12,8a3,3,0,0,1,3,3,1,1,0,0,0,2,0A5,5,0,0,0,12,6,5,5,0,0,0,7,11a1,1,0,0,0,2,0,3,3,0,0,1,3-3A3,3,0,0,1,15,11Z"/><path d="M19,11a1,1,0,0,0,1,1,5.2,5.2,0,0,1-4,5,5.1,5.1,0,0,1-2,0,5.2,5.2,0,0,1-4-5,1,1,0,0,0,0-2,7.2,7.2,0,0,0,5,2,7.1,7.1,0,0,0,3-1A1,1,0,0,0,19,11Z"/>{off && <path d="M3.29,4.71a1,1,0,0,0-1.42,1.42l18,18a1,1,0,0,0,1.42,0,1,1,0,0,0,0-1.42Z"/>}</svg>);


// --- Single User Panel Component ---
const UserPanel: FC<{ initialUserId: string }> = ({ initialUserId }) => {
    // Refs
    const localVideoRef = useRef<HTMLVideoElement>(null);
    const remoteVideoRef = useRef<HTMLVideoElement>(null);
    const pc = useRef<RTCPeerConnection | null>(null);
    const signalingChannel = useRef<RealtimeChannel | null>(null);
    const roomListener = useRef<RealtimeChannel | null>(null);
    const localStreamRef = useRef<MediaStream | null>(null);
    const queuedCandidates = useRef<RTCIceCandidateInit[]>([]);
    
    // State
    const [userId] = useState<string>(initialUserId);
    const [peerId, setPeerId] = useState<string | null>(null);
    const [roomId, setRoomId] = useState<string | null>(null);
    const [status, setStatus] = useState<string>('Ready');
    const [isMuted, setIsMuted] = useState(false);
    const [isVideoOff, setIsVideoOff] = useState(false);
    const [showLocalVideo, setShowLocalVideo] = useState(false);
    const [showRemoteVideo, setShowRemoteVideo] = useState(false);
    const [isBusy, setIsBusy] = useState(false);

    const log = (message: string, ...args: any[]) => console.log(`[${userId || 'NO_ID'}] - ${message}`, ...args);

    useEffect(() => {
        return () => {
            hangUp(userId, false);
        }
    }, [userId]); // Add userId to dependency array for correctness

    const startLocalVideo = async (): Promise<boolean> => {
        if (localStreamRef.current) return true;
        log("Requesting local media...");
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
            log("Local media acquired successfully.");
            localStreamRef.current = stream;
            if (localVideoRef.current) {
                localVideoRef.current.srcObject = stream;
            }
            setShowLocalVideo(true);
            return true;
        } catch (error) {
            log("Error accessing media devices.", error);
            setStatus('Error');
            return false;
        }
    };

    const startChat = async (): Promise<void> => {
        log(`Start chat initiated.`);
        if (isBusy) return;
        setIsBusy(true);
        
        const hasVideo = await startLocalVideo();
        if (!hasVideo) { setIsBusy(false); return; }
        
        setStatus('Searching...');

        roomListener.current = supabase.channel(`room-notification-for-${userId}`)
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'rooms' }, (payload) => {
                const newRoom = payload.new as { id: string, peer1: string, peer2: string };
                if ((newRoom.peer1 === userId || newRoom.peer2 === userId) && !pc.current) {
                    setPeerId(newRoom.peer1 === userId ? newRoom.peer2 : newRoom.peer1);
                    if (roomListener.current) { supabase.removeChannel(roomListener.current).then(() => roomListener.current = null); }
                    setRoomId(newRoom.id);
                    setupSignalingChannel(newRoom.id);
                }
            }).subscribe();
        
        const { data, error } = await supabase.rpc('match_and_create_room', { requesting_user_id: userId });
        if (error) {
            setStatus("Error");
            if (roomListener.current) supabase.removeChannel(roomListener.current);
            setIsBusy(false);
            return;
        }
        
        if (data && data.length > 0 && data[0].room_id) {
            const match = data[0];
            setPeerId(match.peer_id);
            if (roomListener.current) { supabase.removeChannel(roomListener.current).then(() => roomListener.current = null); }
            setRoomId(match.room_id);
            setupSignalingChannel(match.room_id);
            createOffer(match.room_id);
        } else {
            setStatus('Waiting...');
            setIsBusy(false);
        }
    };

    const setupSignalingChannel = (currentRoomId: string) => {
        const channel = supabase.channel(`signaling-${currentRoomId}`);
        signalingChannel.current = channel;
        channel.on('broadcast', { event: 'signal' }, async ({ payload }: { payload: SignalPayload }) => {
            if (payload.userId === userId) return;
            if (!pc.current) createPeerConnection(currentRoomId);
            if ('offer' in payload) {
                await pc.current!.setRemoteDescription(new RTCSessionDescription(payload.offer));
                processQueuedCandidates();
                const answer = await pc.current!.createAnswer();
                await pc.current!.setLocalDescription(answer);
                signalingChannel.current?.send({ type: 'broadcast', event: 'signal', payload: { answer, userId } });
            } else if ('answer' in payload) {
                if (pc.current!.signalingState === 'have-local-offer') {
                    await pc.current!.setRemoteDescription(new RTCSessionDescription(payload.answer));
                    processQueuedCandidates();
                }
            } else if ('candidate' in payload) {
                if (pc.current!.remoteDescription) {
                    await pc.current!.addIceCandidate(new RTCIceCandidate(payload.candidate));
                } else {
                    queuedCandidates.current.push(payload.candidate);
                }
            }
        }).subscribe();
    }

    const createPeerConnection = (currentRoomId: string): void => {
        if (pc.current) return;
        const peerConnection = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
        localStreamRef.current?.getTracks().forEach(track => {
            if (localStreamRef.current) peerConnection.addTrack(track, localStreamRef.current);
        });
        peerConnection.ontrack = (event) => {
            if (remoteVideoRef.current && event.streams && event.streams[0]) {
                 remoteVideoRef.current.srcObject = event.streams[0];
                 setShowRemoteVideo(true);
            }
        };
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) signalingChannel.current?.send({ type: 'broadcast', event: 'signal', payload: { candidate: event.candidate, userId } });
        };
        peerConnection.onconnectionstatechange = () => {
            const state = pc.current?.connectionState;
            if (state === 'connected') { setStatus('Connected'); setIsBusy(false); }
            if ((state === 'disconnected' || state === 'closed' || state === 'failed')) {
                hangUp(userId, true);
            }
        }
        pc.current = peerConnection;
    };

    const processQueuedCandidates = async () => {
        while (queuedCandidates.current.length > 0) {
            const candidate = queuedCandidates.current.shift();
            if (candidate && pc.current?.remoteDescription) {
                try { await pc.current.addIceCandidate(new RTCIceCandidate(candidate)); } 
                catch (e) { log('Error adding queued ice candidate', e); }
            }
        }
    }

    const createOffer = async (currentRoomId: string): Promise<void> => {
        if (!pc.current) createPeerConnection(currentRoomId);
        const offer = await pc.current!.createOffer();
        await pc.current!.setLocalDescription(offer);
        signalingChannel.current?.send({ type: 'broadcast', event: 'signal', payload: { offer, userId } });
    };
    
    // ** THE FIX IS HERE **
    const hangUp = async (currentUserId: string | null, requeue: boolean = false): Promise<void> => {
        if (isBusy && !requeue) return;
        setIsBusy(true);

        if (pc.current) {
            pc.current.onconnectionstatechange = null;
            pc.current.close();
            pc.current = null;
        }

        if (localStreamRef.current && !requeue) {
            localStreamRef.current.getTracks().forEach(track => track.stop());
            localStreamRef.current = null;
            setShowLocalVideo(false);
        }
        if (remoteVideoRef.current) {
            remoteVideoRef.current.srcObject = null;
        }
        setShowRemoteVideo(false);
        
        const channelsToRemove = [];
        if (signalingChannel.current) channelsToRemove.push(supabase.removeChannel(signalingChannel.current));
        if (roomListener.current) channelsToRemove.push(supabase.removeChannel(roomListener.current));
        await Promise.all(channelsToRemove);

        signalingChannel.current = null; 
        roomListener.current = null;
        
        if (currentUserId) {
            if (requeue) {
                 if (roomId) await supabase.from('rooms').delete().eq('id', roomId);
            } else {
                 await supabase.from('waiting_users').delete().eq('user_id', currentUserId);
                 if (roomId) await supabase.from('rooms').delete().eq('id', roomId);
            }
        }
        setRoomId(null); 
        setPeerId(null); 
        queuedCandidates.current = [];
        
        if (requeue) { 
            setStatus('Finding new partner...'); 
            queueMicrotask(() => startChat());
        } else { 
            setStatus('Ready'); 
            setIsBusy(false); 
        }
    };

    const toggleMute = () => { localStreamRef.current?.getAudioTracks().forEach(t => t.enabled = !t.enabled); setIsMuted(!isMuted); }
    const toggleVideo = () => { localStreamRef.current?.getVideoTracks().forEach(t => t.enabled = !t.enabled); setIsVideoOff(!isVideoOff); }

    return (
        <div className="bg-white border border-gray-200 rounded-lg shadow-lg p-4 flex flex-col">
            <div className="flex justify-between items-center mb-2">
                <p className="text-xs font-mono truncate">ID: {userId}</p>
                <p className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                    status === 'Connected' ? 'bg-green-100 text-green-800' : 
                    status === 'Waiting...' ? 'bg-yellow-100 text-yellow-800' : 
                    'bg-gray-100 text-gray-800'
                }`}>{status}</p>
            </div>
            <div className="relative aspect-video bg-gray-900 rounded-md overflow-hidden mb-2">
                <video ref={remoteVideoRef} autoPlay playsInline className="w-full h-full object-cover" style={{ display: showRemoteVideo ? 'block' : 'none' }} />
                <div className="absolute top-2 right-2 w-1/4 h-1/4 rounded-md overflow-hidden border-2 border-white" style={{ display: showLocalVideo ? 'block' : 'none' }}>
                    <video ref={localVideoRef} autoPlay playsInline muted className={`w-full h-full object-cover ${isVideoOff ? 'opacity-20' : ''}`} />
                </div>
            </div>
            <div className="flex items-center justify-between">
                <button onClick={startChat} disabled={isBusy || !!roomId} className="bg-blue-500 text-white text-xs font-bold px-3 py-1.5 rounded-md disabled:bg-gray-300">
                    Find Partner
                </button>
                <div className="flex items-center space-x-1">
                    <button onClick={toggleMute} disabled={!roomId} className="p-1.5 rounded-md bg-gray-200 disabled:bg-gray-100 disabled:text-gray-400"><MicIcon off={isMuted}/></button>
                    <button onClick={toggleVideo} disabled={!roomId} className="p-1.5 rounded-md bg-gray-200 disabled:bg-gray-100 disabled:text-gray-400"><VideoIcon off={isVideoOff}/></button>
                    <button onClick={() => hangUp(userId, false)} disabled={!roomId} className="p-1.5 rounded-md bg-red-500 text-white disabled:bg-red-200"><PhoneIcon/></button>
                </div>
            </div>
        </div>
    )
}


// --- Main Test Page Component ---
const TestPage: FC = () => {
    const [numUsers, setNumUsers] = useState(2);
    const [users, setUsers] = useState<string[]>([]);
    const [queueCount, setQueueCount] = useState(0);

    const log = (message: string, ...args: any[]) => console.log(`[TEST_PAGE] - ${message}`, ...args);

    useEffect(() => {
        const getQueueCount = async () => {
            const { count, error } = await supabase
                .from('waiting_users')
                .select('*', { count: 'exact', head: true });
            
            if (!error && count !== null) {
                setQueueCount(count);
            }
        };
        getQueueCount();
        const queueListener = supabase.channel('public:waiting_users')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'waiting_users' }, getQueueCount)
            .subscribe();
        return () => {
            supabase.removeChannel(queueListener);
        };
    }, []);

    const handleStartSimulation = () => {
        const newUsers = Array.from({ length: numUsers }, () => `user_${Math.random().toString(36).substr(2, 9)}`);
        setUsers(newUsers);
    };
    
    return (
        <div className="min-h-screen bg-gray-100 p-8">
            <div className="max-w-7xl mx-auto">
                <div className="bg-white p-6 rounded-lg shadow-md mb-8">
                    <h1 className="text-2xl font-bold mb-4">Multi-User Test Environment</h1>
                    <div className="flex items-center space-x-4">
                        <input 
                            type="number"
                            value={numUsers}
                            onChange={(e) => setNumUsers(Math.max(1, parseInt(e.target.value) || 1))}
                            className="border border-gray-300 rounded-md px-3 py-2 w-24"
                        />
                        <button onClick={handleStartSimulation} className="bg-blue-600 text-white font-semibold px-5 py-2 rounded-md hover:bg-blue-700">
                            Start Simulation
                        </button>
                        <div className="ml-auto flex items-center space-x-2">
                           <span className="text-sm font-medium text-gray-600">Users in Queue:</span>
                           <span className="text-lg font-bold text-blue-600 bg-blue-100 px-3 py-1 rounded-full">{queueCount}</span>
                        </div>
                    </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                    {users.map(userId => (
                        <UserPanel key={userId} initialUserId={userId} />
                    ))}
                </div>
            </div>
        </div>
    );
};

export default TestPage;

