// File: /components/ChatPanelContent.tsx

import React, { FC, useRef, useEffect, KeyboardEvent } from 'react';
import Picker, { EmojiClickData } from 'emoji-picker-react';
import { X, Paperclip, Smile, Download, Send } from 'lucide-react';

// --- We need to define or import the types this component uses ---
type AppState = 'IDLE' | 'AWAITING_MEDIA' | 'READY' | 'SEARCHING' | 'CONNECTING' | 'CONNECTED' | 'ERROR';
interface Message { id: string; userId: string; text: string; }
interface MediaMessagePayload { isMedia: true; type: string; url: string; name: string; }


// --- MediaMessage Component ---
const MediaMessage: FC<{ payload: MediaMessagePayload }> = ({ payload }) => { 
    let content; 
    if (payload.type.startsWith('image/')) { 
        content = <img src={payload.url} alt={payload.name} className="max-w-full h-auto rounded-md" />; 
    } else if (payload.type.startsWith('video/')) { 
        content = <video src={payload.url} controls className="max-w-full h-auto rounded-md"></video>; 
    } else if (payload.type.startsWith('audio/')) { 
        content = <audio src={payload.url} controls className="w-full"></audio>; 
    } else { 
        content = <div className='text-sm'>{payload.name || 'Shared file'}</div> 
    } 
    return ( 
        <div className="mt-2"> 
            {content} 
            <a href={payload.url} download={payload.name} target="_blank" rel="noopener noreferrer" className="text-blue-300 text-xs flex items-center mt-1 hover:underline"> 
                <Download size={14} className="mr-1" /> Download
            </a> 
        </div> 
    );
};


// --- Main ChatPanelContent Component ---
// We use `export default` to make it importable by other files
export default function ChatPanelContent({
    messages, userId, setIsChatOpen, chatInput, setChatInput, handleSendMessage, 
    showEmojiPicker, setShowEmojiPicker, handleEmojiClick, handleAttachmentClick, 
    isUploading, appState
}: {
    messages: Message[]; userId: string | null; setIsChatOpen: (isOpen: boolean) => void; chatInput: string; setChatInput: (value: string) => void; handleSendMessage: () => void; showEmojiPicker: boolean; setShowEmojiPicker: (show: boolean) => void; handleEmojiClick: (emojiData: EmojiClickData) => void; handleAttachmentClick: () => void; isUploading: boolean; appState: AppState;
}) {
    const chatContainerRef = useRef<HTMLDivElement>(null);
    useEffect(() => { if (chatContainerRef.current) { chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight; } }, [messages]);

    return (
        <>
            <div className="h-[60px] flex-shrink-0 border-b border-gray-200 px-4 flex items-center justify-between">
                <h2 className="font-semibold">Chat</h2>
                <button onClick={() => setIsChatOpen(false)}><X size={24}/></button>
            </div>
            <div ref={chatContainerRef} className="flex-1 p-4 overflow-y-auto space-y-4">
                {messages.map(msg => {
                    let mediaPayload: MediaMessagePayload | null = null;
                    try { const parsed = JSON.parse(msg.text); if (parsed && parsed.isMedia) mediaPayload = parsed; } catch (e) {}
                    const isSender = msg.userId === userId;
                    const bubbleClasses = isSender ? 'bg-blue-500 text-white rounded-t-2xl rounded-bl-2xl' : 'bg-gray-200 text-gray-800 rounded-t-2xl rounded-br-2xl';
                    return (
                        <div key={msg.id} className={`flex ${isSender ? 'justify-end' : 'justify-start'}`}>
                            <div className={`p-3 px-4 max-w-xs ${bubbleClasses}`}>
                                <p className="text-xs font-semibold mb-1 opacity-90">{isSender ? 'You' : `Stranger`}</p>
                                {mediaPayload ? <MediaMessage payload={mediaPayload} /> : <p className="text-base break-words">{msg.text}</p>}
                            </div>
                        </div>
                    )
                })}
            </div>
             <div className="flex-shrink-0 border-t border-gray-200 p-2 flex flex-col space-y-2 relative">
                {showEmojiPicker && ( <div className="absolute bottom-full right-0 mb-2 z-50"><Picker onEmojiClick={handleEmojiClick} style={{ width: '100%' }} /></div> )}
                 <div className="relative flex items-center space-x-2">
                    <button onClick={handleAttachmentClick} disabled={isUploading} className="p-2 text-gray-500 hover:text-blue-500 disabled:text-gray-300"><Paperclip size={22}/></button>
                    <button onClick={() => setShowEmojiPicker(!showEmojiPicker)} className="p-2 text-gray-500 hover:text-blue-500"><Smile size={22}/></button>
                    <input type="text" value={chatInput} onChange={(e) => setChatInput(e.target.value)} onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => e.key === 'Enter' && handleSendMessage()}
                        placeholder={isUploading ? "Uploading file..." : "Type a message..."} className="flex-1 h-12 bg-gray-100 rounded-lg pl-4 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" disabled={appState !== 'CONNECTED' || isUploading}/>
                    <button onClick={handleSendMessage} disabled={appState !== 'CONNECTED' || !chatInput.trim() || isUploading} className="absolute right-1 top-1/2 -translate-y-1/2 p-2 rounded-full text-gray-500 hover:bg-gray-200 disabled:text-gray-300"><Send size={20}/></button>
                </div>
             </div>
        </>
    );
};