// Filename: /pages/index.tsx
// FINAL VERSION - Includes ICE Restart logic for reconnections.

import { useState, useRef, useEffect, FC, KeyboardEvent, ChangeEvent } from 'react';
import Head from 'next/head'; 
import { supabase } from '../lib/supabaseClient';
import { RealtimeChannel, RealtimePresenceState, Session } from '@supabase/supabase-js';
import { Phone, Video, VideoOff, Mic, MicOff, Send, SkipForward, MessageSquare, X, Paperclip, Smile, Download, Users, CircleDot } from 'lucide-react';
import Picker, { EmojiClickData } from 'emoji-picker-react';
import ProfileSetupModal from '../components/ProfileSetupModal';
import MatchingOptionsBar from '../components/MatchingOptionsBar';
import ChatPanelContent from '../components/ChatPanelContent';

// --- Type Definitions ---
type AppState = 'IDLE' | 'AWAITING_MEDIA' | 'READY' | 'SEARCHING' | 'CONNECTING' | 'CONNECTED' | 'ERROR';
type PresenceStatus = 'online' | 'searching' | 'connected';
interface OfferPayload { offer: RTCSessionDescriptionInit; }
interface AnswerPayload { answer: RTCSessionDescriptionInit; }
interface CandidatePayload { candidate: RTCIceCandidateInit; }
interface Message { id: string; userId: string; text: string; }
interface MediaMessagePayload { isMedia: true; type: string; url: string; name: string; }
interface Profile { id: string; is_profile_complete: boolean; [key: string]: any; }

// --- Chat Controller Class ---
class ChatController {
  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private queuedCandidates: RTCIceCandidateInit[] = [];
  private lobbyChannel: RealtimeChannel | null = null;
  private directMessageChannel: RealtimeChannel | null = null;
  private roomChannel: RealtimeChannel | null = null;
  private presenceChannel: RealtimeChannel | null = null;
  private pairingTimeout: NodeJS.Timeout | null = null;
  private userId: string;
  private isTransitioning: boolean = false;
  private isOfferCreator: boolean = false;
  private internalState: AppState = 'IDLE';
  private onStateChange: (state: AppState) => void;
  private onLocalStream: (stream: MediaStream | null) => void;
  private onRemoteStream: (stream: MediaStream | null) => void;
  private onNewMessage: (message: Message) => void;
  private onNewConnection: () => void;
  constructor(userId: string, onStateChange: (state: AppState) => void, onLocalStream: (stream: MediaStream | null) => void, onRemoteStream: (stream: MediaStream | null) => void, onNewMessage: (message: Message) => void, onNewConnection: () => void) { this.userId = userId; this.onStateChange = onStateChange; this.onLocalStream = onLocalStream; this.onRemoteStream = onRemoteStream; this.onNewMessage = onNewMessage; this.onNewConnection = onNewConnection; }
  private setState = (state: AppState) => { this.internalState = state; this.onStateChange(state); this.updatePresenceStatus(); }
  private updatePresenceStatus = () => { if (!this.presenceChannel) return; let status: PresenceStatus = 'online'; if (this.internalState === 'SEARCHING') status = 'searching'; if (this.internalState === 'CONNECTED') status = 'connected'; this.presenceChannel.track({ status }); }
  public getUserId = (): string => this.userId;
  public initialize = async (): Promise<void> => { this.setState('AWAITING_MEDIA'); try { if (!this.localStream) { const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true }); this.localStream = stream; this.onLocalStream(stream); } this.presenceChannel = supabase.channel('global-presence', { config: { presence: { key: this.userId } } }); this.presenceChannel.subscribe(async (status) => { if (status === 'SUBSCRIBED') { this.updatePresenceStatus(); } }); this.setState('IDLE'); } catch (err) { this.setState('ERROR'); } }
  public startChat = async (): Promise<void> => { if (this.isTransitioning) return; this.isTransitioning = true; this.setState('SEARCHING'); await this.cleanup(); const dmChannelName = `dm-${this.userId}`; this.directMessageChannel = supabase.channel(dmChannelName); this.directMessageChannel.on('broadcast', { event: 'pairing_request' }, async ( { payload }: { payload: { roomId: string } } ) => { if (this.pc || this.isTransitioning) return; this.isTransitioning = true; this.isOfferCreator = false; await this.cleanupLobby(); await this.joinRoom(payload.roomId); await this.roomChannel?.send({ type: 'broadcast', event: 'peer_ready', payload: {} }); this.isTransitioning = false; }).subscribe(); this.lobbyChannel = supabase.channel('lobby', { config: { broadcast: { ack: true } } }); this.lobbyChannel.on('broadcast', { event: 'looking_for_partner' }, async ({ payload }: { payload: { directChannel: string } }) => { if (this.pc || this.isTransitioning) return; if (payload.directChannel === dmChannelName) return; this.isTransitioning = true; this.isOfferCreator = true; await this.cleanupLobby(); const newRoomId = `room_${Math.random().toString(36).substring(2, 12)}`; this.pairingTimeout = setTimeout(() => { this.hangUp(true); }, 5000); await supabase.channel(payload.directChannel).send({ type: 'broadcast', event: 'pairing_request', payload: { roomId: newRoomId } }); await this.joinRoom(newRoomId); this.isTransitioning = false; }).subscribe(async (status) => { if (status === 'SUBSCRIBED') { this.isTransitioning = false; await this.lobbyChannel?.send({ type: 'broadcast', event: 'looking_for_partner', payload: { directChannel: dmChannelName } }); } }); }
  private joinRoom = async (roomId: string): Promise<void> => { this.setState('CONNECTING'); this.roomChannel = supabase.channel(`signaling-${roomId}`); this.roomChannel.on('broadcast', { event: 'peer_ready' }, async () => { if (this.isOfferCreator) { if (this.pairingTimeout) clearTimeout(this.pairingTimeout); this.pairingTimeout = null; await this.createOffer(); } }).on('broadcast', { event: 'offer' }, async ({ payload }: { payload: OfferPayload }) => { if (!this.pc) this.createPeerConnection(); await this.pc!.setRemoteDescription(new RTCSessionDescription(payload.offer)); this.processQueuedCandidates(); const answer = await this.pc!.createAnswer(); await this.pc!.setLocalDescription(answer); await this.roomChannel?.send({ type: 'broadcast', event: 'answer', payload: { answer } }); }).on('broadcast', { event: 'answer' }, async ({ payload }: { payload: AnswerPayload }) => { if (this.pc?.signalingState === 'have-local-offer') { await this.pc.setRemoteDescription(new RTCSessionDescription(payload.answer)); this.processQueuedCandidates(); } }).on('broadcast', { event: 'candidate' }, async ({ payload }: { payload: CandidatePayload }) => { if (this.pc?.remoteDescription) { await this.pc.addIceCandidate(new RTCIceCandidate(payload.candidate)); } else { this.queuedCandidates.push(payload.candidate); } }).subscribe(); }
  private createPeerConnection = (): void => { if (this.pc) return; this.pc = new RTCPeerConnection({ iceServers: [ { urls: 'stun:stun.l.google.com:19302' }, { urls: 'turn:relay.metered.ca:80', username: '83e21626570551a6152b3433', credential: 'aDN0a7Hj6sUe3R3a' } ] }); this.dataChannel = this.pc.createDataChannel('chat'); this.dataChannel.onmessage = (e) => this.onNewMessage(JSON.parse(e.data)); this.pc.ondatachannel = (e) => { this.dataChannel = e.channel; this.dataChannel.onmessage = (ev) => this.onNewMessage(JSON.parse(ev.data)); }; this.localStream?.getTracks().forEach(track => this.pc!.addTrack(track, this.localStream!)); this.pc.ontrack = (e) => this.onRemoteStream(e.streams[0]); this.pc.onicecandidate = async (e) => { if (e.candidate) { await this.roomChannel?.send({ type: 'broadcast', event: 'candidate', payload: { candidate: e.candidate } }); } }; this.pc.onconnectionstatechange = () => { const state = this.pc?.connectionState; if (state === 'connected') { this.setState('CONNECTED'); this.onNewConnection(); } else if (state === 'disconnected' || state === 'failed') { this.hangUp(true); } }; }
  private createOffer = async (): Promise<void> => { if (!this.pc) this.createPeerConnection(); const offer = await this.pc!.createOffer(); await this.pc!.setLocalDescription(offer); await this.roomChannel?.send({ type: 'broadcast', event: 'offer', payload: { offer } }); }
  private cleanup = async (): Promise<void> => { this.pc?.close(); this.pc = null; if (this.pairingTimeout) clearTimeout(this.pairingTimeout); this.pairingTimeout = null; await this.cleanupLobby(); if(this.directMessageChannel) await supabase.removeChannel(this.directMessageChannel); if(this.roomChannel) await supabase.removeChannel(this.roomChannel); this.directMessageChannel = null; this.roomChannel = null; this.queuedCandidates = []; this.isOfferCreator = false; }
  private cleanupLobby = async (): Promise<void> => { if(this.lobbyChannel) await supabase.removeChannel(this.lobbyChannel); this.lobbyChannel = null; }
  public hangUp = async (reconnect: boolean = false): Promise<void> => { if (this.isTransitioning && !reconnect) return; this.isTransitioning = true; this.onRemoteStream(null); if (this.pc?.connectionState !== 'connected' && reconnect) { this.setState('SEARCHING'); } else if (!reconnect) { this.setState('IDLE'); } await this.cleanup(); if (reconnect) { setTimeout(() => { this.isTransitioning = false; this.startChat(); }, 250); } else { this.presenceChannel?.untrack(); if(this.presenceChannel) supabase.removeChannel(this.presenceChannel); this.isTransitioning = false; } }
  public sendMessage = (text: string): Message | null => { if (text.trim() && this.dataChannel?.readyState === 'open') { const message: Message = { id: `msg_${Math.random()}`, userId: this.userId, text }; this.dataChannel.send(JSON.stringify(message)); return message; } return null; };
  public toggleMute = (): void => { this.localStream?.getAudioTracks().forEach(t => t.enabled = !t.enabled); }
  public toggleVideo = (): void => { this.localStream?.getVideoTracks().forEach(t => t.enabled = !t.enabled); }
  public processQueuedCandidates = (): void => { while (this.queuedCandidates.length > 0 && this.pc?.remoteDescription) { const cand = this.queuedCandidates.shift(); if (cand) this.pc!.addIceCandidate(new RTCIceCandidate(cand)).catch(e => console.error('ICE error:', e)); } };
  
  // --- ADDED: New method for handling reconnection ---
  public attemptToReconnect = () => {
    if (this.pc && (this.pc.connectionState === 'disconnected' || this.pc.connectionState === 'failed')) {
        console.log('Connection was lost, attempting ICE restart...');
        this.pc.restartIce();
    }
  }
}


// Assume ChatPanelContent is now also a real component file
// import ChatPanelContent from '../components/ChatPanelContent';

// --- Main React Component ---
const Home: FC = () => {
    // --- State Hooks ---
    const [authLoading, setAuthLoading] = useState(true);
    const [session, setSession] = useState<Session | null>(null);
    const [profile, setProfile] = useState<Profile | null>(null);
    const [userId, setUserId] = useState<string | null>(null);
    const [isMuted, setIsMuted] = useState(false);
    const [isVideoOff, setIsVideoOff] = useState(false);
    const [messages, setMessages] = useState<Message[]>([]);
    const [chatInput, setChatInput] = useState('');
    const [localStream, setLocalStream] = useState<MediaStream | null>(null);
    const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
    const [appState, setAppState] = useState<AppState>('IDLE');
    const [isChatOpen, setIsChatOpen] = useState(false);
    const [showEmojiPicker, setShowEmojiPicker] = useState(false);
    const [isUploading, setIsUploading] = useState(false);
    const [onlineCount, setOnlineCount] = useState(0);
    const [connectedCount, setConnectedCount] = useState(0);
    const [hasUnreadMessages, setHasUnreadMessages] = useState(false);
    
    // --- Ref Hooks ---
    const localVideoRef = useRef<HTMLVideoElement>(null);
    const remoteVideoRef = useRef<HTMLVideoElement>(null);
    const controllerRef = useRef<ChatController | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // --- useEffect Hooks ---
    useEffect(() => {
        const handleAuthAndProfile = async () => {
          setAuthLoading(true);
          const { data: { session } } = await supabase.auth.getSession();
          let activeSession = session;
          if (!activeSession) {
            const { data: { session: newSession } } = await supabase.auth.signInAnonymously();
            activeSession = newSession;
          }
          setSession(activeSession);
          if (activeSession) {
              const { data: profileData } = await supabase.from('profiles').select('*').eq('id', activeSession.user.id).single();
              setProfile(profileData);
          }
          setAuthLoading(false);
        };
        handleAuthAndProfile();
        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
          setSession(session);
          if (_event === 'SIGNED_OUT') setProfile(null);
        });
        return () => subscription?.unsubscribe();
    }, []);

    useEffect(() => {
        if (session && !authLoading && controllerRef.current === null) {
            const chatController = new ChatController(
                session.user.id, setAppState, setLocalStream, setRemoteStream,
                (message: Message) => setMessages(prev => [...prev, message]),
                () => setMessages([])
            );
            controllerRef.current = chatController;
            setUserId(chatController.getUserId());
            chatController.initialize(); 
        }
        const controller = controllerRef.current;
        const handleBeforeUnload = () => controller?.hangUp(false);
        window.addEventListener('beforeunload', handleBeforeUnload);
        return () => {
            window.removeEventListener('beforeunload', handleBeforeUnload);
            controller?.hangUp(false);
        }
    }, [session, authLoading]);

    useEffect(() => {
        const channel = supabase.channel('global-presence');
        const updateCounts = () => {
            const presenceState: RealtimePresenceState = channel.presenceState();
            const rawUsers = Object.values(presenceState).map((node: any) => node[0]);
            const users = rawUsers.filter(user => user);
            const connected = users.filter(user => user.status === 'connected').length;
            const waiting = users.filter(user => user.status === 'searching').length;
            setConnectedCount(connected);
            setOnlineCount(connected + waiting);
        };
        channel.on('presence', { event: 'sync' }, updateCounts);
        channel.subscribe();
        return () => { supabase.removeChannel(channel); }
    }, [])

    useEffect(() => {
        if (messages.length === 0) return;
        const lastMessage = messages[messages.length - 1];
        if (lastMessage && lastMessage.userId !== userId && !isChatOpen) {
            setHasUnreadMessages(true);
        }
    }, [messages, userId, isChatOpen]);

    useEffect(() => { 
        if (localVideoRef.current && localStream) {
            localVideoRef.current.srcObject = localStream;
        } 
    }, [localStream]);
    
    useEffect(() => { if (remoteVideoRef.current && remoteStream) remoteVideoRef.current.srcObject = remoteStream; }, [remoteStream]);
    
    // --- ADDED: New useEffect for handling tab visibility ---
    useEffect(() => {
        const handleVisibilityChange = () => {
            // When the user brings the tab back into focus
            if (document.visibilityState === 'visible') {
                controllerRef.current?.attemptToReconnect();
            }
        };
        document.addEventListener('visibilitychange', handleVisibilityChange);
        return () => {
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, []); // Empty array ensures this runs only once.

    // --- Handler Functions ---
    const handleEmojiClick = (emojiData: EmojiClickData) => { setChatInput(prevInput => prevInput + emojiData.emoji); setShowEmojiPicker(false); };
    const handleAttachmentClick = () => { fileInputRef.current?.click(); };
    const handleFileSelect = async (event: ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; if (!file) return; const controller = controllerRef.current; if (!controller) return; setIsUploading(true); try { const filePath = `public/${controller.getUserId()}-${Date.now()}-${file.name}`; const { error: uploadError } = await supabase.storage.from('media-files').upload(filePath, file); if (uploadError) throw uploadError; const { data } = supabase.storage.from('media-files').getPublicUrl(filePath); const messagePayload: MediaMessagePayload = { isMedia: true, type: file.type, url: data.publicUrl, name: file.name }; const messageText = JSON.stringify(messagePayload); const sentMessage = controller.sendMessage(messageText); if (sentMessage) setMessages(prev => [...prev, sentMessage]); } catch (error) { const sentMessage = controller.sendMessage(`[Error: Failed to upload ${file.name}]`); if (sentMessage) setMessages(prev => [...prev, sentMessage]); } finally { setIsUploading(false); } };
    const handleSendMessage = () => { const sentMessage = controllerRef.current?.sendMessage(chatInput.trim()); if (sentMessage) { setMessages(prev => [...prev, sentMessage]); setChatInput(''); } };
    const handleToggleMute = () => { controllerRef.current?.toggleMute(); setIsMuted(!isMuted); }
    const handleToggleVideo = () => { controllerRef.current?.toggleVideo(); setIsVideoOff(!isVideoOff); }
    const getStatusText = (): string => { switch (appState) { case 'IDLE': return 'Ready to Chat'; case 'SEARCHING': return 'Searching for a partner...'; case 'CONNECTING': return 'Connecting...'; case 'CONNECTED': return 'Connected'; default: return 'Loading...'; } };

    if (authLoading) {
        return <div className="h-screen w-screen flex items-center justify-center bg-gray-900 text-white">Loading...</div>;
    }
    
    const chatPanelProps = { messages, userId, isChatOpen, setIsChatOpen, chatInput, setChatInput, handleSendMessage, showEmojiPicker, setShowEmojiPicker, handleEmojiClick, handleAttachmentClick, isUploading, appState };

    return (
        <>
            <Head>
                <title>Video Chat App</title>
                <meta name='description' content='A peer-to-peer video chat application.' />
                <link rel="manifest" href="/manifest.json" />
                <meta name="theme-color" content="#5096F7" />
                <meta name="apple-mobile-web-app-capable" content="yes" />
                <meta name="apple-mobile-web-app-status-bar-style" content="default" />
                <meta name="apple-mobile-web-app-title" content="VideoChat" />
                <link rel="apple-touch-icon" href="/icon-192x192.png" />
            </Head>

            {profile && !profile.is_profile_complete && session && (
                <ProfileSetupModal 
                    user={session.user} 
                    onComplete={() => window.location.reload()} 
                />
            )}

            <input type="file" ref={fileInputRef} onChange={handleFileSelect} className="hidden" accept="image/*,video/*,audio/*"/>

            <main className="h-screen w-screen bg-black flex font-sans overflow-x-hidden">
                <div className="flex-1 flex flex-col relative transition-all duration-300 ease-in-out">
                    <header className="absolute top-0 left-0 right-0 z-30 h-[60px] md:h-[72px] flex items-center px-4 md:px-6 justify-between bg-gradient-to-b from-black/50 to-transparent">
                        <h1 className="text-lg md:text-xl font-semibold text-white">Video Chat</h1>
                        <div className="flex items-center space-x-4 md:space-x-6 bg-black/30 backdrop-blur-sm px-3 py-1.5 rounded-full text-white">
                           <div className="flex items-center space-x-2 text-xs md:text-sm font-medium"><Users size={16} className="opacity-80"/> <span className="font-bold text-green-400">{onlineCount}</span> <span className="hidden sm:inline opacity-80">Online</span></div>
                           <div className="flex items-center space-x-2 text-xs md:text-sm font-medium"><CircleDot size={16} className="opacity-80"/> <span className="font-bold text-blue-400">{connectedCount}</span> <span className="hidden sm:inline opacity-80">Connected</span></div>
                        </div>
                    </header>
                    <div className="absolute inset-0 w-full h-full z-0">
                        <video ref={remoteVideoRef} autoPlay playsInline className="w-full h-full object-contain bg-black" />
                    </div>
                    {appState !== 'CONNECTED' && (
                       <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/40 text-white p-4 text-center z-10 pointer-events-none">
                           <h2 className="text-2xl md:text-3xl font-semibold drop-shadow-lg">{getStatusText()}</h2>
                           {appState === 'IDLE' && (
                               <button onClick={() => controllerRef.current?.startChat()} className="mt-6 bg-blue-500 font-semibold rounded-lg px-8 py-3 transition-transform hover:scale-105 pointer-events-auto">Find Partner</button>
                           )}
                       </div>
                    )}
                    {/* This new version has responsive aspect ratios and positioning */}
                    <div className="absolute top-4 right-4 w-36 md:w-60 rounded-lg overflow-hidden shado-lg z-20 aspect-[3/4] md:aspect-video">
                         <video ref={localVideoRef} autoPlay playsInline muted className="w-full h-full object-cover bg-black/50" />
                        {isVideoOff && <div className="absolute inset-0 bg-black/70 flex items-center justify-center text-xs"><p>Video Off</p></div>}
                    </div>
                    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center justify-center space-x-3 bg-black/30 backdrop-blur-sm p-3 rounded-full z-30">
                        <button onClick={handleToggleMute} className={`p-3 rounded-full text-white ${isMuted ? 'bg-red-500' : 'bg-white/20'}`}><>{isMuted ? <MicOff size={24} /> : <Mic size={24} />}</></button>
                        <button onClick={handleToggleVideo} className={`p-3 rounded-full text-white ${isVideoOff ? 'bg-red-500' : 'bg-white/20'}`}><>{isVideoOff ? <VideoOff size={24} /> : <Video size={24} />}</></button>
                        <button onClick={() => { setIsChatOpen(!isChatOpen); setHasUnreadMessages(false); }} className="p-3 rounded-full bg-white/20 text-white relative">
                            <MessageSquare size={24} />
                            {hasUnreadMessages && !isChatOpen && (
                                <span className="absolute top-1 right-1 block h-3 w-3 rounded-full bg-red-500 border-2 border-black/50"></span>
                            )}
                        </button>
                        <button onClick={() => controllerRef.current?.hangUp(true)} disabled={appState !== 'CONNECTED'} className="p-3 rounded-full bg-gray-500 disabled:bg-gray-700 text-white"><SkipForward size={24} /></button>
                        <button onClick={() => controllerRef.current?.hangUp(false)} disabled={appState === 'IDLE'} className="p-3 rounded-full bg-red-600 disabled:bg-red-400 text-white"><Phone size={24} /></button>
                    </div>
                </div>
                
                <div className={`
                    flex-col bg-white text-black flex-shrink-0
                    transition-all duration-300 ease-in-out
                    
                    max-md:absolute max-md:inset-0 max-md:z-50
                    ${isChatOpen ? 'max-md:translate-y-0' : 'max-md:translate-y-full'}
                    ${isChatOpen ? 'flex' : 'hidden'}

                    md:w-96 md:border-l md:border-gray-200
                    md:flex
                    ${isChatOpen ? 'md:max-w-96' : 'md:max-w-0'}
                `}>
                    <ChatPanelContent {...chatPanelProps} />
                </div>
            </main>
        </>
    );
};

export default Home;