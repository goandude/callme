// File: /components/CustomPlacesAutocomplete.tsx
import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useDebounce } from 'use-debounce';

interface Prediction {
  description: string;
  place_id: string;
}

interface CustomPlacesAutocompleteProps {
  onPlaceSelected: (placeDescription: string) => void;
  className?: string;
  placeholder?: string;
}

export default function CustomPlacesAutocomplete({ onPlaceSelected, className, placeholder }: CustomPlacesAutocompleteProps) {
  const [inputValue, setInputValue] = useState('');
  const [predictions, setPredictions] = useState<Prediction[]>([]);
  const [loading, setLoading] = useState(false);
  const [debouncedInput] = useDebounce(inputValue, 400); // Wait 400ms after user stops typing

  useEffect(() => {
    // Don't search for very short strings
    if (debouncedInput.length < 3) {
      setPredictions([]);
      return;
    }

    const fetchPredictions = async () => {
      setLoading(true);
      const { data, error } = await supabase.functions.invoke('place-autocomplete', {
        body: { input: debouncedInput }
      });
      if (error) {
        console.error("Error fetching predictions:", error);
      } else {
        setPredictions(data || []);
      }
      setLoading(false);
    };

    fetchPredictions();
  }, [debouncedInput]);

  const handleSelect = (prediction: Prediction) => {
    const placeDescription = prediction.description;
    setInputValue(placeDescription);
    onPlaceSelected(placeDescription);
    setPredictions([]); // Close the dropdown after selection
  };

  return (
    <div className="relative w-full">
      <input
        type="text"
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        className={className}
        placeholder={placeholder || "Enter your city..."}
        autoComplete="off" // Disable browser's native autocomplete
      />
      {(loading || predictions.length > 0) && (
        <ul className="absolute z-10 w-full bg-slate-600 border border-slate-500 rounded-md mt-1 shadow-lg max-h-60 overflow-y-auto">
          {loading && <li className="px-4 py-2 text-slate-400">Searching...</li>}
          {!loading && predictions.map((p) => (
            <li
              key={p.place_id}
              onClick={() => handleSelect(p)}
              className="px-4 py-2 text-white cursor-pointer hover:bg-slate-700"
            >
              {p.description}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}