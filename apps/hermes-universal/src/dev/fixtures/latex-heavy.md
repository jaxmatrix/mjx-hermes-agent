You have great intuition! Your hypothesis about "surface control" is exactly on the right track.

While I wasn't able to extract the specific text of the attached paper due to a system block on my execution tools, the electrochemical reasoning for this is a fundamental principle in electrochemistry.

Here is why measuring **Double-Layer Capacitance ($C_{dl}$)** via Cyclic Voltammetry (CV) is the standard, preferred method for calculating the **Electrochemically Active Surface Area (ECSA)**, rather than using Electrochemical Impedance Spectroscopy (EIS) and fitting it to a Randles circuit.

### 1. The CV Method Isolates the Pure Surface Area (Non-Faradaic)

To measure the true surface area of an electrode, you want to count *only* the physical surface where ions from the electrolyte can make contact.
When we use CV to measure ECSA, we intentionally choose a narrow voltage window where **no chemical reactions (Faradaic processes) occur**. In this non-Faradaic region, the only thing happening is ions electrostatically lining up on the surface to balance the charge (forming the electrical double layer).

Because this charging is a purely physical, **surface-controlled** process, the double-layer capacitance ($C_{dl}$) is strictly proportional to the surface area:

$$ECSA = \frac{C_{dl}}{C_s}$$

*(Where $C_s$ is the specific capacitance of an ideal, flat surface of the same material, usually between 20-60 µF/cm²).*

### 2. Why the Randles Circuit is Problematic for Surface Area

A Randles circuit is used to model EIS data. The standard Randles circuit consists of:

*   $R_s$ (Solution Resistance)
*   $C_{dl}$ (Double-Layer Capacitance)
*   $R_{ct}$ (Charge Transfer Resistance)
*   $Z_W$ (Warburg Impedance - diffusion)

Here is why scientists avoid using this to calculate ECSA:

**A. It Requires a Redox Reaction (Faradaic Process)**

To get a meaningful $R_{ct}$ and $Z_W$ in a Randles circuit, you usually need a redox probe in your solution (like ferri/ferrocyanide). This means electrons are transferring across the interface. Once you introduce a Faradaic reaction, the current is no longer just "surface-controlled"; it becomes a mix of kinetic (charge transfer) and diffusion-controlled processes, muddying the waters.

**B. The "Constant Phase Element" (CPE) Problem**

Real electrodes (especially nanostructured, porous, or battery materials) are rarely perfectly smooth. When you run EIS on rough electrodes, they don't act like perfect capacitors. The semi-circle in the Nyquist plot gets "depressed".
To make the Randles circuit fit the real data, scientists have to replace the ideal capacitor ($C_{dl}$) with a "Constant Phase Element" (CPE). A CPE is a mathematical fudge factor that represents a "leaky" or imperfect capacitor. Converting a CPE value back into a true Capacitance ($C$) to calculate surface area requires complex mathematical formulas (like the Brug or Hsu-Mansfeld equations) that introduce significant error and assumptions.

**C. Frequency Dependency**

In EIS, the capacitance changes depending on the frequency of the AC signal. At high frequencies, the signal might only penetrate the outer geometric surface of a porous electrode, ignoring the deep pores. CV sweeps (when done at relatively slow scan rates) give the ions enough time to penetrate all the active pores, giving a much more accurate measurement of the *total* available surface area.

### Summary

You use the **CV Capacitance Method** because it strictly measures physical, surface-controlled ion adsorption without the interference of chemical reactions.

You avoid the **Randles Circuit (EIS)** for surface area because real, rough electrodes force you to use complex mathematical approximations (CPEs), and the presence of charge-transfer and diffusion processes makes isolating the pure surface capacitance highly prone to error.

### Appendix: denser math, for the stress case

The interfacial impedance of the Randles cell is $Z(\omega) = R_s + \left(\frac{1}{R_{ct} + Z_W} + j\omega C_{dl}\right)^{-1}$, with the Warburg term $Z_W = \frac{\sigma}{\sqrt{\omega}}(1 - j)$ and $\sigma$ the Warburg coefficient. Replacing $C_{dl}$ with a CPE of admittance $Y_0 (j\omega)^n$ gives the Brug correction

$$C_{dl} = Y_0^{1/n} \left( \frac{1}{R_s} + \frac{1}{R_{ct}} \right)^{(n-1)/n}$$

which reduces to $C_{dl} = Y_0$ only when $n = 1$. In the non-Faradaic window the measured current is $i = \nu C_{dl}$ for scan rate $\nu$, so a plot of $i$ against $\nu$ has slope $C_{dl}$ and the surface area follows from $A = C_{dl}/C_s$ with $C_s \approx 40\,\mu\mathrm{F}\,\mathrm{cm}^{-2}$. Diffusion-limited peaks instead follow Randles-Ševčík, $i_p = 0.4463\, n F A C \sqrt{\frac{n F \nu D}{R T}}$, whose $\sqrt{\nu}$ dependence is exactly the signature that distinguishes a diffusion-controlled process from the surface-controlled one at $\nu^1$.

| quantity | symbol | typical value |
| --- | --- | --- |
| solution resistance | $R_s$ | $5$–$50\,\Omega$ |
| charge transfer resistance | $R_{ct}$ | $10^2$–$10^5\,\Omega$ |
| double-layer capacitance | $C_{dl}$ | $10$–$10^3\,\mu\mathrm{F}$ |
| CPE exponent | $n$ | $0.8$–$1.0$ |

```math
\mathrm{ECSA} = \frac{C_{dl}}{C_s}, \qquad \mathrm{RF} = \frac{\mathrm{ECSA}}{A_{geo}}
```

A quick sanity check in code:

```python
def ecsa(c_dl_farads: float, c_s_farads_per_cm2: float = 40e-6) -> float:
    """Electrochemically active surface area in cm^2."""
    return c_dl_farads / c_s_farads_per_cm2
```

> [!NOTE]
> The specific capacitance $C_s$ is material- and electrolyte-dependent; using a
> literature value for a different system is the single largest source of error in
> a reported ECSA.
