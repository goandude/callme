// File: /components/ProfileSetupModal.tsx
// NEW, SIMPLIFIED VERSION - Uses a plain text field for the city.

import { useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { User } from '@supabase/supabase-js';

interface ProfileSetupModalProps {
  user: User;
  onComplete: () => void;
}

export default function ProfileSetupModal({ user, onComplete }: ProfileSetupModalProps) {
  const [age, setAge] = useState('');
  const [sex, setSex] = useState('M');
  const [city, setCity] = useState(''); // State for our simple text input
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

   const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!age || !sex || !city) {
      setError('Please fill out all fields.');
      return;
    }
    setLoading(true);
    setError('');

    // We add .select() at the end to get back the data that was updated
    const { data, error: updateError, count } = await supabase
      .from('profiles')
      .update({
        age: parseInt(age),
        sex: sex,
        city: city,
        is_profile_complete: true,
      })
      .eq('id', user.id)
      .select(); // <-- Add this

    // This log will show us exactly what happened
    console.log('[DEBUG] Supabase update response:', { data, updateError, count });

    // We can also check if the number of updated rows was 0
    if (updateError || count === 0) {
      setError(updateError?.message || "Failed to update profile. Please try again.");
      setLoading(false);
    } else {
      onComplete();
    }
  };
  return (
    <div className="fixed inset-0 bg-black bg-opacity-75 flex justify-center items-center z-50">
      <div className="bg-slate-800 p-8 rounded-lg shadow-xl w-full max-w-md">
        <h2 className="text-2xl font-bold text-white mb-4">Complete Your Profile</h2>
        <form onSubmit={handleSubmit}>
          <div className="mb-4">
            <label htmlFor="age" className="block text-slate-300 mb-2">Age</label>
            <input id="age" type="number" value={age} onChange={(e) => setAge(e.target.value)} className="w-full p-2 bg-slate-700 rounded text-white" required />
          </div>
          <div className="mb-4">
            <label htmlFor="sex" className="block text-slate-300 mb-2">Sex</label>
            <select id="sex" value={sex} onChange={(e) => setSex(e.target.value)} className="w-full p-2 bg-slate-700 rounded text-white">
              <option value="M">Male</option>
              <option value="F">Female</option>
            </select>
          </div>
          <div className="mb-6">
            <label htmlFor="city" className="block text-slate-300 mb-2">Your City</label>
            <input 
              id="city"
              type="text" 
              value={city} 
              onChange={(e) => setCity(e.target.value)} 
              className="w-full p-2 bg-slate-700 rounded text-white" 
              placeholder="e.g., Mumbai" 
              required 
            />
          </div>
          <button type="submit" disabled={loading} className="w-full bg-blue-500 text-white font-bold py-3 rounded-lg hover:bg-blue-600 transition-colors disabled:bg-slate-500">
            {loading ? 'Saving...' : 'Save Profile'}
          </button>
          {error && <p className="text-red-500 mt-4 text-center">{error}</p>}
        </form>
      </div>
    </div>
  );
}