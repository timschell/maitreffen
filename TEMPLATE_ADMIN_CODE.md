# Template-Admin Code zum Einfügen in admin.html

## 1. State hinzufügen (nach Zeile ~505):

```javascript
// Templates
const [templates, setTemplates] = useState([]);
const [templatesLoading, setTemplatesLoading] = useState(false);
const [templateEditModalOpen, setTemplateEditModalOpen] = useState(false);
const [editingTemplate, setEditingTemplate] = useState(null);
```

## 2. Load Templates Function (nach checkAuth):

```javascript
// Templates laden
const loadTemplates = async () => {
    setTemplatesLoading(true);
    try {
        const res = await fetch(`${API_URL}/admin/item-templates`, {
            headers: authHeaders()
        });
        if (!res.ok) throw new Error('Fehler');
        const data = await res.json();
        setTemplates(data);
    } catch (err) {
        console.error(err);
        alert('Fehler beim Laden der Templates');
    } finally {
        setTemplatesLoading(false);
    }
};

// Template erstellen/bearbeiten
const saveTemplate = async (templateData) => {
    const url = editingTemplate 
        ? `${API_URL}/admin/item-templates/${editingTemplate.id}`
        : `${API_URL}/admin/item-templates`;
    
    const res = await fetch(url, {
        method: editingTemplate ? 'PUT' : 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(templateData)
    });
    
    if (!res.ok) throw new Error('Fehler beim Speichern');
    
    await loadTemplates();
    setTemplateEditModalOpen(false);
    setEditingTemplate(null);
};

// Template löschen
const deleteTemplate = async (templateId) => {
    if (!confirm('Template wirklich löschen?')) return;
    
    const res = await fetch(`${API_URL}/admin/item-templates/${templateId}`, {
        method: 'DELETE',
        headers: authHeaders()
    });
    
    if (!res.ok) throw new Error('Fehler beim Löschen');
    await loadTemplates();
};

// Template auf Mahlzeit anwenden
const applyTemplate = async (mealId, templateId) => {
    try {
        const res = await fetch(`${API_URL}/admin/meals/${mealId}/apply-template/${templateId}`, {
            method: 'POST',
            headers: authHeaders()
        });
        
        if (!res.ok) throw new Error('Fehler beim Anwenden');
        
        const result = await res.json();
        alert(`✅ ${result.itemsCreated} Items hinzugefügt!`);
        await loadMeals(selectedEventId);
    } catch (err) {
        alert('Fehler beim Anwenden des Templates');
    }
};
```

## 3. Tab hinzufügen (in den Tabs):

Ändere die Tabs-Section:
```javascript
<div className="tabs">
    <button className={`tab ${activeTab === 'events' ? 'active' : ''}`} onClick={() => setActiveTab('events')}>Events</button>
    <button className={`tab ${activeTab === 'meals' ? 'active' : ''}`} onClick={() => setActiveTab('meals')}>Mahlzeiten</button>
    <button className={`tab ${activeTab === 'templates' ? 'active' : ''}`} onClick={() => setActiveTab('templates')}>📚 Templates</button>
    <button className={`tab ${activeTab === 'users' ? 'active' : ''}`} onClick={() => setActiveTab('users')}>Nutzer</button>
</div>
```

## 4. Templates Tab Content (nach dem meals-Tab):

```javascript
{/* Templates Tab */}
{activeTab === 'templates' && (
    <div>
        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem'}}>
            <div>
                <h2 style={{marginBottom: '0.5rem'}}>📚 Item-Templates</h2>
                <p style={{color: 'var(--text-muted)', fontSize: '0.9rem'}}>
                    Wiederverwendbare Layouts für Grill- und Frühstücks-Events
                </p>
            </div>
            <button 
                className="btn btn-primary" 
                onClick={() => {
                    setEditingTemplate(null);
                    setTemplateEditModalOpen(true);
                    if (templates.length === 0) loadTemplates();
                }}
            >
                + Neues Template
            </button>
        </div>
        
        {templatesLoading ? (
            <div style={{textAlign: 'center', padding: '3rem', color: 'var(--text-muted)'}}>Lade Templates...</div>
        ) : templates.length === 0 ? (
            <div className="empty-state">
                <div className="empty-state-icon">📚</div>
                <div>Noch keine Templates erstellt</div>
                <button 
                    className="btn btn-primary" 
                    style={{marginTop: '1rem'}}
                    onClick={() => {
                        setEditingTemplate(null);
                        setTemplateEditModalOpen(true);
                    }}
                >
                    Erstes Template erstellen
                </button>
            </div>
        ) : (
            <div style={{display: 'grid', gap: '1rem'}}>
                {templates.map(template => (
                    <div key={template.id} className="card">
                        <div className="card-header">
                            <div>
                                <div className="card-title">
                                    {template.template_type === 'grill' ? '🔥' : '🥐'} {template.name}
                                </div>
                                {template.description && (
                                    <div className="card-subtitle">{template.description}</div>
                                )}
                                <div style={{marginTop: '0.5rem', fontSize: '0.85rem', color: 'var(--text-muted)'}}>
                                    {template.items?.length || 0} Items · {template.template_type === 'grill' ? 'Grill' : 'Frühstück'}
                                </div>
                            </div>
                            <div style={{display: 'flex', gap: '0.5rem'}}>
                                <button 
                                    className="btn btn-sm btn-secondary"
                                    onClick={() => {
                                        setEditingTemplate(template);
                                        setTemplateEditModalOpen(true);
                                    }}
                                >
                                    ✏️ Bearbeiten
                                </button>
                                <button 
                                    className="btn btn-sm btn-danger"
                                    onClick={() => deleteTemplate(template.id)}
                                >
                                    🗑️
                                </button>
                            </div>
                        </div>
                        
                        {/* Items Preview */}
                        {template.items && template.items.length > 0 && (
                            <div style={{
                                display: 'grid',
                                gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
                                gap: '0.5rem',
                                marginTop: '1rem',
                                padding: '1rem',
                                background: '#fafafa',
                                borderRadius: '8px'
                            }}>
                                {template.items.slice(0, 12).map(item => (
                                    <div key={item.id} style={{
                                        padding: '0.5rem',
                                        background: 'white',
                                        borderRadius: '6px',
                                        fontSize: '0.75rem',
                                        textAlign: 'center',
                                        border: '1px solid var(--border)'
                                    }}>
                                        <div style={{fontSize: '1.5rem', marginBottom: '0.25rem'}}>
                                            {item.emoji || '🍽️'}
                                        </div>
                                        <div style={{fontWeight: 600, fontSize: '0.7rem'}}>
                                            {item.name}
                                        </div>
                                    </div>
                                ))}
                                {template.items.length > 12 && (
                                    <div style={{
                                        padding: '0.5rem',
                                        background: '#e0e0e0',
                                        borderRadius: '6px',
                                        fontSize: '0.75rem',
                                        textAlign: 'center',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        fontWeight: 600
                                    }}>
                                        +{template.items.length - 12}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                ))}
            </div>
        )}
    </div>
)}
```

## 5. Template Edit Modal Component (vor dem ReactDOM.render):

```javascript
// Template Edit Modal
function TemplateEditModal({ template, onSave, onClose }) {
    const [formData, setFormData] = useState({
        name: template?.name || '',
        description: template?.description || '',
        templateType: template?.template_type || 'grill',
        items: template?.items || []
    });
    const [saving, setSaving] = useState(false);
    const [newItem, setNewItem] = useState({ name: '', itemType: '', unit: 'pieces', emoji: '', sortOrder: 0 });
    
    const addItem = () => {
        if (!newItem.name.trim()) {
            alert('Bitte einen Namen eingeben');
            return;
        }
        
        setFormData(prev => ({
            ...prev,
            items: [...prev.items, { ...newItem, sortOrder: prev.items.length }]
        }));
        
        setNewItem({ name: '', itemType: '', unit: 'pieces', emoji: '', sortOrder: 0 });
    };
    
    const removeItem = (index) => {
        setFormData(prev => ({
            ...prev,
            items: prev.items.filter((_, i) => i !== index)
        }));
    };
    
    const updateItem = (index, field, value) => {
        setFormData(prev => ({
            ...prev,
            items: prev.items.map((item, i) => 
                i === index ? { ...item, [field]: value } : item
            )
        }));
    };
    
    const moveItem = (index, direction) => {
        const newItems = [...formData.items];
        const targetIndex = direction === 'up' ? index - 1 : index + 1;
        
        if (targetIndex < 0 || targetIndex >= newItems.length) return;
        
        [newItems[index], newItems[targetIndex]] = [newItems[targetIndex], newItems[index]];
        
        // Update sort_order
        newItems.forEach((item, i) => {
            item.sortOrder = i;
        });
        
        setFormData(prev => ({ ...prev, items: newItems }));
    };
    
    const handleSubmit = async (e) => {
        e.preventDefault();
        
        if (!formData.name.trim()) {
            alert('Bitte einen Namen eingeben');
            return;
        }
        
        if (formData.items.length === 0) {
            alert('Bitte mindestens ein Item hinzufügen');
            return;
        }
        
        setSaving(true);
        try {
            await onSave(formData);
        } catch (err) {
            alert('Fehler beim Speichern');
        } finally {
            setSaving(false);
        }
    };
    
    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal" onClick={e => e.stopPropagation()} style={{maxWidth: '800px'}}>
                <h2>{template ? '✏️ Template bearbeiten' : '📚 Neues Template'}</h2>
                
                <form onSubmit={handleSubmit}>
                    <div className="form-row">
                        <div className="form-group">
                            <label>Template-Name *</label>
                            <input
                                type="text"
                                value={formData.name}
                                onChange={e => setFormData(prev => ({ ...prev, name: e.target.value }))}
                                placeholder="z.B. Grill-Standard"
                                required
                            />
                        </div>
                        <div className="form-group">
                            <label>Typ *</label>
                            <select
                                value={formData.templateType}
                                onChange={e => setFormData(prev => ({ ...prev, templateType: e.target.value }))}
                            >
                                <option value="grill">🔥 Grill</option>
                                <option value="breakfast">🥐 Frühstück</option>
                            </select>
                        </div>
                    </div>
                    
                    <div className="form-group">
                        <label>Beschreibung</label>
                        <textarea
                            value={formData.description}
                            onChange={e => setFormData(prev => ({ ...prev, description: e.target.value }))}
                            placeholder="Optional: Beschreibung für dieses Template"
                        />
                    </div>
                    
                    {/* Items */}
                    <div style={{marginTop: '1.5rem', marginBottom: '1rem'}}>
                        <h3 style={{marginBottom: '1rem'}}>Items ({formData.items.length})</h3>
                        
                        {formData.items.length > 0 && (
                            <div style={{marginBottom: '1rem', maxHeight: '300px', overflowY: 'auto'}}>
                                {formData.items.map((item, index) => (
                                    <div key={index} style={{
                                        display: 'grid',
                                        gridTemplateColumns: '40px 2fr 1.5fr 1fr 1fr 80px',
                                        gap: '0.5rem',
                                        alignItems: 'center',
                                        padding: '0.5rem',
                                        background: '#fafafa',
                                        borderRadius: '6px',
                                        marginBottom: '0.5rem'
                                    }}>
                                        <div style={{textAlign: 'center', fontSize: '1.5rem'}}>
                                            {item.emoji || '🍽️'}
                                        </div>
                                        <input
                                            type="text"
                                            value={item.name}
                                            onChange={e => updateItem(index, 'name', e.target.value)}
                                            placeholder="Name"
                                            style={{padding: '0.5rem', border: '1px solid var(--border)', borderRadius: '6px'}}
                                        />
                                        <input
                                            type="text"
                                            value={item.itemType || ''}
                                            onChange={e => updateItem(index, 'itemType', e.target.value)}
                                            placeholder="Typ"
                                            style={{padding: '0.5rem', border: '1px solid var(--border)', borderRadius: '6px'}}
                                        />
                                        <select
                                            value={item.unit}
                                            onChange={e => updateItem(index, 'unit', e.target.value)}
                                            style={{padding: '0.5rem', border: '1px solid var(--border)', borderRadius: '6px'}}
                                        >
                                            <option value="pieces">Stück</option>
                                            <option value="kg">kg</option>
                                            <option value="g">g</option>
                                            <option value="l">l</option>
                                            <option value="ml">ml</option>
                                        </select>
                                        <input
                                            type="text"
                                            value={item.emoji || ''}
                                            onChange={e => updateItem(index, 'emoji', e.target.value)}
                                            placeholder="🍽️"
                                            maxLength="4"
                                            style={{padding: '0.5rem', border: '1px solid var(--border)', borderRadius: '6px', textAlign: 'center'}}
                                        />
                                        <div style={{display: 'flex', gap: '0.25rem'}}>
                                            <button
                                                type="button"
                                                onClick={() => moveItem(index, 'up')}
                                                disabled={index === 0}
                                                style={{padding: '0.25rem 0.5rem', fontSize: '0.75rem'}}
                                                className="btn btn-sm btn-secondary"
                                            >
                                                ↑
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => moveItem(index, 'down')}
                                                disabled={index === formData.items.length - 1}
                                                style={{padding: '0.25rem 0.5rem', fontSize: '0.75rem'}}
                                                className="btn btn-sm btn-secondary"
                                            >
                                                ↓
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => removeItem(index)}
                                                style={{padding: '0.25rem 0.5rem', fontSize: '0.75rem'}}
                                                className="btn btn-sm btn-danger"
                                            >
                                                ✕
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                        
                        {/* Add Item Row */}
                        <div style={{
                            display: 'grid',
                            gridTemplateColumns: '40px 2fr 1.5fr 1fr 1fr 80px',
                            gap: '0.5rem',
                            alignItems: 'center',
                            padding: '0.75rem',
                            background: 'var(--primary-light)',
                            borderRadius: '6px',
                            border: '2px dashed var(--primary)'
                        }}>
                            <input
                                type="text"
                                value={newItem.emoji}
                                onChange={e => setNewItem(prev => ({ ...prev, emoji: e.target.value }))}
                                placeholder="🍽️"
                                maxLength="4"
                                style={{padding: '0.5rem', border: '1px solid var(--border)', borderRadius: '6px', textAlign: 'center', fontSize: '1.2rem'}}
                            />
                            <input
                                type="text"
                                value={newItem.name}
                                onChange={e => setNewItem(prev => ({ ...prev, name: e.target.value }))}
                                placeholder="Name *"
                                style={{padding: '0.5rem', border: '1px solid var(--border)', borderRadius: '6px'}}
                            />
                            <input
                                type="text"
                                value={newItem.itemType}
                                onChange={e => setNewItem(prev => ({ ...prev, itemType: e.target.value }))}
                                placeholder="Typ (optional)"
                                style={{padding: '0.5rem', border: '1px solid var(--border)', borderRadius: '6px'}}
                            />
                            <select
                                value={newItem.unit}
                                onChange={e => setNewItem(prev => ({ ...prev, unit: e.target.value }))}
                                style={{padding: '0.5rem', border: '1px solid var(--border)', borderRadius: '6px'}}
                            >
                                <option value="pieces">Stück</option>
                                <option value="kg">kg</option>
                                <option value="g">g</option>
                                <option value="l">l</option>
                                <option value="ml">ml</option>
                            </select>
                            <div></div>
                            <button
                                type="button"
                                onClick={addItem}
                                className="btn btn-primary btn-sm"
                                style={{whiteSpace: 'nowrap'}}
                            >
                                + Add
                            </button>
                        </div>
                    </div>
                    
                    <div className="modal-buttons">
                        <button type="button" className="btn btn-secondary" onClick={onClose}>
                            Abbrechen
                        </button>
                        <button type="submit" className="btn btn-primary" disabled={saving}>
                            {saving ? 'Speichere...' : (template ? 'Speichern' : 'Template erstellen')}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
```

## 6. Template Edit Modal rendern (am Ende der AdminApp, vor ReactDOM.render):

```javascript
{/* Template Edit Modal */}
{templateEditModalOpen && (
    <TemplateEditModal
        template={editingTemplate}
        onSave={saveTemplate}
        onClose={() => {
            setTemplateEditModalOpen(false);
            setEditingTemplate(null);
        }}
    />
)}
```

## 7. "Template anwenden" Button bei Mahlzeiten hinzufügen:

In der Meal-Card (wo Items angezeigt werden), nach dem "+ Item" Button:

```javascript
{(meal.meal_type === 'grill' || meal.meal_type === 'breakfast') && (
    <>
        <button 
            className="btn btn-sm btn-primary" 
            onClick={() => {
                setEditingItem(null);
                setEditingItemMealId(meal.id);
                setItemModalOpen(true);
            }}
        >
            + Item
        </button>
        <button 
            className="btn btn-sm btn-warning" 
            onClick={async () => {
                if (templates.length === 0) await loadTemplates();
                const templateType = meal.meal_type === 'breakfast' ? 'breakfast' : 'grill';
                const availableTemplates = templates.filter(t => t.template_type === templateType);
                
                if (availableTemplates.length === 0) {
                    alert('Keine passenden Templates gefunden');
                    return;
                }
                
                const templateNames = availableTemplates.map((t, i) => `${i + 1}. ${t.name} (${t.items?.length || 0} Items)`).join('\n');
                const choice = prompt(`Template anwenden:\n\n${templateNames}\n\nGib die Nummer ein:`);
                
                if (choice) {
                    const index = parseInt(choice) - 1;
                    if (index >= 0 && index < availableTemplates.length) {
                        await applyTemplate(meal.id, availableTemplates[index].id);
                    }
                }
            }}
        >
            📚 Template
        </button>
    </>
)}
```
