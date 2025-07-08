// File: /components/MatchingOptionsBar.tsx
// FINAL REFACTORED VERSION

import { useState, useEffect } from 'react';
import { useProfile } from '../context/ProfileContext'; // We import our global hook
import { supabase } from '../lib/supabaseClient';

export default function MatchingOptionsBar() {
  // Get the profile directly from our global context.
  const { profile } = useProfile();

  // Local state is used to manage the form inputs for a responsive UI
  const [prefSex, setPrefSex] = useState('A'); // Default to 'Any'
  const [prefAgeMin, setPrefAgeMin] = useState(18);
  const [prefAgeMax, setPrefAgeMax] = useState(99);
  const [isLoading, setIsLoading] = useState(false);

  // When the component loads and the global profile object is available,
  // populate our local form state with the preferences from the database.
  useEffect(() => {
    if (profile) {
      setPrefSex(profile.pref_sex || 'A');
      setPrefAgeMin(profile.pref_age_min || 18);
      setPrefAgeMax(profile.pref_age_max || 99);
    }
  }, [profile]); // This effect runs whenever the global profile object changes

  const handlePreferenceChange = async (field: string, value: any) => {
    if (!profile) return;

    // Update the UI immediately by setting local state
    if (field === 'pref_sex') setPrefSex(value);
    if (field === 'pref_age_min') setPrefAgeMin(parseInt(value));
    if (field === 'pref_age_max') setPrefAgeMax(parseInt(value));
    
    // Save the change to the database in the background
    const { error } = await supabase
      .from('profiles')
      .update({ [field]: value })
      .eq('id', profile.id);

    if (error) {
      console.error('Error updating preference:', error);
    }
  };
  
  const handleFindPartner = () => {
    if (!profile) return alert('Your profile is not loaded yet.');
    setIsLoading(true);
    console.log("Searching with preferences:", { prefSex, prefAgeMin, prefAgeMax });
    // This is where you will eventually call your matching Edge Function
    setTimeout(() => setIsLoading(false), 2000); // Simulate search
  };

  // Do not render the bar until the profile is loaded AND the initial setup is complete.
  if (!profile || !profile.is_profile_complete) {
    return null;
  }

  return (
    <div className="w-full bg-slate-900 p-2 flex items-center justify-center gap-4 text-white rounded-lg mb-4">
      <span className="font-bold">Match with:</span>
      <div>
        <label className="text-sm text-slate-400 mr-2">Sex:</label>
        <select
          value={prefSex}
          onChange={(e) => handlePreferenceChange('pref_sex', e.target.value)}
          className="bg-slate-700 p-1 rounded text-white"
        >
          <option value="A">Any</option>
          <option value="F">Female</option>
          <option value="M">Male</option>
        </select>
      </div>
      <div>
        <label className="text-sm text-slate-400 mr-2">Age:</label>
        <input
          type="number"
          min="18"
          value={prefAgeMin}
          onChange={(e) => handlePreferenceChange('pref_age_min', e.target.value)}
          className="w-16 bg-slate-700 p-1 rounded text-white"
        />
        <span className="mx-1">-</span>
        <input
          type="number"
          min="18"
          value={prefAgeMax}
          onChange={(e) => handlePreferenceChange('pref_age_max', e.target.value)}
          className="w-16 bg-slate-700 p-1 rounded text-white"
        />
      </div>
      <button 
        onClick={handleFindPartner} 
        disabled={isLoading}
        className="bg-green-500 font-bold px-6 py-2 rounded-lg hover:bg-green-600 disabled:bg-slate-500"
      >
        {isLoading ? 'Searching...' : 'Find Partner'}
      </button>
    </div>
  );
}